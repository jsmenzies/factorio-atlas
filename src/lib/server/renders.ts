/**
 * Game-look render files (scripts/render-game.ts; layout in #lib/viewer/game-render.ts): in dev
 * the renders folder on disk first (RENDERS_DIR, else data/renders: where `bun run render` writes), then the RENDERS bucket; deployed
 * stages read only the bucket. Sidecars, page data and indexes of another format version count as missing.
 *
 * Browsers fetch the images from `renderBase()`: the bucket's custom domain (`RENDERS_URL`) when
 * deployed with one, through Cloudflare's cache without reaching the Worker; otherwise this site's
 * `/prints/<id>/render/<file>` route.
 */
import { dev } from '$app/env';
import { env } from 'cloudflare:workers';
import { readDataFile } from './dev-files.js';
import { PAGE_DATA_VERSION, type RenderIndex, type RenderPageData, type RenderSidecar } from '#lib/viewer/game-render.js';
import { THUMBS_INDEX, thumbSrcset, type PageThumb, type ThumbsIndex } from '#lib/viewer/thumbs.js';

export interface RenderFile {
	body: ReadableStream;
	etag?: string;
}

/** URL prefix of a print's render images (no trailing slash). */
export const renderBase = (id: string): string => {
	const url = (env as Partial<Env>).RENDERS_URL?.trim();
	return url ? `${url.replace(/\/+$/, '')}/${encodeURIComponent(id)}` : `/prints/${encodeURIComponent(id)}/render`;
};

/** `key` is `<print id>/<file>`; callers check `<file>` against RENDER_FILE first. */
export async function getRenderFile(key: string): Promise<RenderFile | null> {
	if (dev) {
		// Page thumbnails sit in their own folder on disk (THUMBS_DIR), beside the renders in the bucket.
		const file = (await readDataFile('renders', key)) ?? (await readDataFile('thumbs', key));
		if (file) return file;
	}
	const bucket = (env as Partial<Env>).RENDERS;
	const obj = bucket ? await bucket.get(key) : null;
	return obj ? { body: obj.body, etag: obj.httpEtag } : null;
}

/**
 * A render JSON file, or null when it's missing, of another version, unreadable or not JSON: a
 * failed bucket read only hides the render, so the print and render pages still load.
 */
async function getJson<T extends { v: number }>(key: string, v: T['v']): Promise<T | null> {
	try {
		const file = await getRenderFile(key);
		if (!file) return null;
		const json = (await new Response(file.body).json()) as T;
		return json.v === v ? json : null;
	} catch (e) {
		console.warn(`render file ${key}: ${e instanceof Error ? e.message : String(e)}`);
		return null;
	}
}

export const getRenderSidecar = (id: string, base: string) => getJson<RenderSidecar>(`${id}/${base}.json`, 2);

/** A rendered page's entity data for hover tooltips (`<base>.page.json`). */
export const getRenderPageData = (id: string, base: string) => getJson<RenderPageData>(`${id}/${base}.page.json`, PAGE_DATA_VERSION);

/**
 * From one read of the print's render index: each rendered page's book path and overview file.
 * Empty when it has none or the index can't be read.
 */
export const renderOverviews = async (id: string): Promise<Record<string, string>> => {
	const index = await getJson<RenderIndex>(`${id}/index.json`, 2);
	return Object.fromEntries(Object.entries(index?.pages ?? {}).map(([path, page]) => [path, page.overview]));
};

/** Book paths of the print's pages that have a render; empty when it has none or its index can't be read. */
export const renderedPages = async (id: string): Promise<string[]> => Object.keys(await renderOverviews(id));

/** The print's page thumbnails (`<id>/thumbs.json`); null when it has none or it can't be read. */
export const getThumbsIndex = (id: string) => getJson<ThumbsIndex>(`${id}/${THUMBS_INDEX}`, 1);

/** The print's page thumbnails as srcsets, by book path; none until `render:thumbs` has made them. */
export const pageThumbs = async (id: string): Promise<Record<string, PageThumb>> => {
	const index = await getThumbsIndex(id);
	const base = renderBase(id);
	return Object.fromEntries(
		Object.entries(index?.pages ?? {}).map(([path, p]) => [path, { srcset: thumbSrcset(base, path, p), w: p.w, h: p.h }])
	);
};
