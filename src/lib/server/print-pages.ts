/**
 * Viewer pages and per-page strings for the print page's inline viewer, the full-screen render
 * page and the string endpoint. They read the files made at ingest (`viewer/<id>/` in the RAW
 * bucket, see pipeline/viewer-files.ts), so no request inflates a blueprint.
 */
import { env } from 'cloudflare:workers';
import { rawKey } from '#lib/server/pipeline/pipeline.js';
import { pageStringKey, parseViewerIndex, viewerIndexKey, viewerPageKey } from '#lib/server/pipeline/viewer-files.js';
import { getRenderSidecar } from '#lib/server/renders.js';
import { firstPagePath } from '#lib/viewer/extract.js';
import { pageBase } from '#lib/viewer/game-render.js';
import type { CompactPage } from '#lib/viewer/types.js';

const read = async (key: string) => (await (await env.RAW.get(key))?.text()) ?? null;

/** A book path as `listPages` writes it: "" for the root, else "3", "3/1", … */
const BOOK_PATH = /^\d+(?:\/\d+)*$/;

/** The print's whole exchange string from its raw record (a plain read, nothing inflated), or null when it isn't stored. */
export const loadString = async (id: string): Promise<string | null> => {
	const raw = await read(rawKey(id));
	if (raw === null) return null;
	try {
		const s = (JSON.parse(raw) as { blueprintString?: unknown }).blueprintString;
		return typeof s === 'string' ? s : null;
	} catch {
		return null;
	}
};

/** One blueprint page's own exchange string, or null when the print or page has none. */
export const loadPageString = (id: string, path: string): Promise<string | null> =>
	path === '' || BOOK_PATH.test(path) ? read(pageStringKey(id, path)) : Promise.resolve(null);

/**
 * One book page as a compact entity list plus its game render, for the viewer. `requested`
 * is a book path (`print_nodes.path`); anything else falls back to the first blueprint.
 * Null when the print has no viewer files.
 */
export const loadViewerPage = async (id: string, requested: string | null) => {
	const index = parseViewerIndex(await read(viewerIndexKey(id)));
	if (index === null) return null;
	const { pages } = index;
	const path = requested !== null && pages.some((p) => p.path === requested && p.kind === 'blueprint') ? requested : firstPagePath(pages);
	if (path === null) return { pages, page: null, render: null };
	const [text, render] = await Promise.all([read(viewerPageKey(id, path)), getRenderSidecar(id, pageBase(path))]);
	const page = text === null ? null : (JSON.parse(text) as CompactPage);
	return { pages, page, render: page ? render : null };
};
