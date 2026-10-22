/**
 * Per-print files made once at ingest instead of on every view: the page list and each blueprint
 * page's own exchange string, in R2 under `viewer/<id>/`. Requests then read one small object
 * instead of fetching and inflating the whole raw record (up to 10 MB in, 120 MB out, in a 128 MB
 * isolate). The per-page entity data for hover tooltips is made with the game render instead
 * (scripts/render-game.ts), since only rendered pages have a viewer.
 */
import { Effect } from 'effect';
import { listPagesWithNodes } from '#lib/viewer/extract.js';
import { pageBase } from '#lib/viewer/game-render.js';
import type { PageRef } from '#lib/viewer/types.js';
import { encodeExchangeString } from './decode';
import { StorageError } from './errors';
import { RawStore } from './raw-store';

/** Bump when these files change (listPages output, the strings): re-ingest then rebuilds them without re-analysing. */
export const VIEWER_VERSION = 4;
/** Up to this version the files also held each page's entity data, at `legacyPageKey`. */
const LAST_WITH_PAGE_DATA = 3;

export const viewerIndexKey = (id: string) => `viewer/${id}/index.json`;
export const pageStringKey = (id: string, path: string) => `viewer/${id}/${pageBase(path)}.txt`;
/** Where versions up to 3 kept a page's entity data; only deleted now. */
export const legacyPageKey = (id: string, path: string) => `viewer/${id}/${pageBase(path)}.json`;

export interface ViewerIndex {
	v: typeof VIEWER_VERSION;
	/** Every node in book order, books included (for the page picker). */
	pages: PageRef[];
}

const contentType = (key: string) => (key.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'application/json');

/** Every file for one print, keyed by R2 key. Pure apart from string compression. */
export const buildViewerFiles = async (id: string, decoded: unknown): Promise<Map<string, string>> => {
	const { pages, nodes } = listPagesWithNodes(decoded);
	const files = new Map<string, string>([[viewerIndexKey(id), JSON.stringify({ v: VIEWER_VERSION, pages } satisfies ViewerIndex)]]);
	for (const p of pages) {
		if (p.kind !== 'blueprint') continue;
		const node = nodes.get(p.path);
		if (!node) continue;
		files.set(pageStringKey(id, p.path), await encodeExchangeString({ [node.kind]: node.body }));
	}
	return files;
};

/** The keys an index of `version` points at (the index itself excluded). */
const keysOf = (id: string, { version, pages }: Previous) =>
	pages
		.filter((p) => p.kind === 'blueprint')
		.flatMap((p) =>
			version !== null && version <= LAST_WITH_PAGE_DATA
				? [legacyPageKey(id, p.path), pageStringKey(id, p.path)]
				: [pageStringKey(id, p.path)]
		);

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

interface Previous {
	version: number | null;
	pages: PageRef[];
}

/**
 * For cleanup: the pages any earlier index listed, and its version, so a VIEWER_VERSION bump still
 * finds the files to delete. Unreadable indexes list nothing.
 */
const previousPages = (text: string | null): Previous => {
	if (text === null) return { version: null, pages: [] };
	try {
		const { v, pages } = JSON.parse(text) as { v?: unknown; pages?: unknown };
		return {
			version: typeof v === 'number' ? v : null,
			pages: Array.isArray(pages) ? (pages as PageRef[]).filter((p) => typeof p?.path === 'string') : []
		};
	} catch {
		return { version: null, pages: [] };
	}
};

/** R2 writes in flight per print while storing its viewer files. */
const PUT_CONCURRENCY = 8;

/** A print's viewer files keyed by R2 key, as `buildViewerFiles` makes them. */
export type ViewerFiles = ReadonlyMap<string, string>;

/**
 * Store viewer files built by `buildViewerFiles`, and delete files an earlier version of the print
 * had but this one doesn't (pages it lost; entity data written by VIEWER_VERSION 3 and earlier).
 * Strings first, the index last, so a reader never sees an index pointing at missing pages. They
 * go up a few at a time: a big book has hundreds, and each is a round trip when R2 is remote.
 * Returns the number of objects written.
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
