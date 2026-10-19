/**
 * The viewer's data, made once at ingest instead of on every view: a page list,
 * each blueprint page's compact entity data, and each page's own exchange string, in R2 under
 * `viewer/<id>/`. Requests then read one small object instead of fetching and inflating the
 * whole raw record (up to 10 MB in, 120 MB out, in a 128 MB isolate).
 */
import { Effect } from 'effect';
import { gameCatalog } from '#lib/viewer/catalog.server.js';
import { extractPage, listPages, nodeAt } from '#lib/viewer/extract.js';
import { pageBase } from '#lib/viewer/game-render.js';
import type { CompactPage, PageRef } from '#lib/viewer/types.js';
import { encodeExchangeString } from './decode';
import { StorageError } from './errors';
import { RawStore } from './raw-store';

/** Bump when extract.ts output changes: re-ingest then rebuilds viewer files without re-analysing. */
export const VIEWER_VERSION = 1;

export const viewerIndexKey = (id: string) => `viewer/${id}/index.json`;
export const viewerPageKey = (id: string, path: string) => `viewer/${id}/${pageBase(path)}.json`;
export const pageStringKey = (id: string, path: string) => `viewer/${id}/${pageBase(path)}.txt`;

export interface ViewerIndex {
	v: typeof VIEWER_VERSION;
	/** Every node in book order, books included (for the page picker). */
	pages: PageRef[];
}

const catalog = gameCatalog();

const contentType = (key: string) => (key.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'application/json');

/** Every file for one print, keyed by R2 key. Pure apart from string compression. */
export const buildViewerFiles = async (id: string, decoded: unknown): Promise<Map<string, string>> => {
	const pages = listPages(decoded);
	const files = new Map<string, string>([[viewerIndexKey(id), JSON.stringify({ v: VIEWER_VERSION, pages } satisfies ViewerIndex)]]);
	for (const p of pages) {
		if (p.kind !== 'blueprint') continue;
		const page = extractPage(decoded, p.path, catalog);
		const node = nodeAt(decoded, p.path);
		if (!page || !node) continue;
		files.set(viewerPageKey(id, p.path), JSON.stringify(page satisfies CompactPage));
		files.set(pageStringKey(id, p.path), await encodeExchangeString({ [node.kind]: node.body }));
	}
	return files;
};

/** The page and string keys an index points at (the index itself excluded). */
const keysOf = (id: string, pages: readonly PageRef[]) =>
	pages.filter((p) => p.kind === 'blueprint').flatMap((p) => [viewerPageKey(id, p.path), pageStringKey(id, p.path)]);

/** For readers: the index, or null when it's missing, unreadable or from another VIEWER_VERSION. */
export const parseViewerIndex = (text: string | null): ViewerIndex | null => {
	if (text === null) return null;
	try {
		const index = JSON.parse(text) as ViewerIndex;
		return index.v === VIEWER_VERSION && Array.isArray(index.pages) ? index : null;
	} catch {
		return null;
	}
};

/**
 * For cleanup: the pages any earlier index listed, whatever its version, so a VIEWER_VERSION
 * bump still finds the files to delete. Unreadable indexes list nothing.
 */
const previousPages = (text: string | null): PageRef[] => {
	if (text === null) return [];
	try {
		const pages = (JSON.parse(text) as { pages?: unknown }).pages;
		return Array.isArray(pages) ? (pages as PageRef[]).filter((p) => typeof p?.path === 'string') : [];
	} catch {
		return [];
	}
};

/** R2 writes in flight per print while storing its viewer files. */
const PUT_CONCURRENCY = 8;

/** A print's viewer files keyed by R2 key, as `buildViewerFiles` makes them. */
export type ViewerFiles = ReadonlyMap<string, string>;

/**
 * Store viewer files built by `buildViewerFiles`, and delete pages an earlier version of the print
 * had but this one doesn't. Pages and strings first, the index last, so a reader never sees an
 * index pointing at missing pages. Pages go up a few at a time: a big book has hundreds, and each is
 * a round trip when R2 is remote. Returns the number of objects written.
 */
export const putViewerFiles = (id: string, files: ViewerFiles) =>
	Effect.gen(function* () {
		const raw = yield* RawStore;
		const indexKey = viewerIndexKey(id);
		const old = previousPages(yield* raw.get(indexKey));
		const pages = [...files].filter(([key]) => key !== indexKey);
		yield* Effect.forEach(pages, ([key, body]) => raw.put(key, body, contentType(key)), { concurrency: PUT_CONCURRENCY, discard: true });
		yield* raw.put(indexKey, files.get(indexKey)!);
		const orphans = keysOf(id, old).filter((key) => !files.has(key));
		yield* Effect.forEach(orphans, (key) => raw.delete(key), { concurrency: PUT_CONCURRENCY, discard: true });
		return files.size;
	});

/** `buildViewerFiles` as an Effect; a throw is a StorageError, so the print errors and is retried next run. */
export const buildViewerFilesEffect = (id: string, decoded: unknown) =>
	Effect.tryPromise({
		try: () => buildViewerFiles(id, decoded),
		catch: (cause) => new StorageError({ op: `viewer.build ${id}`, cause })
	});

/** Remove a print's viewer files, e.g. when it stops decoding. The index goes first, so readers see a missing print. */
export const deleteViewerFiles = (id: string) =>
	Effect.gen(function* () {
		const raw = yield* RawStore;
		const previous = yield* raw.get(viewerIndexKey(id));
		if (previous === null) return;
		yield* raw.delete(viewerIndexKey(id));
		for (const key of keysOf(id, previousPages(previous))) yield* raw.delete(key);
	});
