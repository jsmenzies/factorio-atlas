/**
 * Viewer pages and per-page strings for the print page's inline viewer, the full-screen render
 * page and the string endpoint. The page list and strings are files made at ingest (`viewer/<id>/`
 * in the RAW bucket, see pipeline/viewer-files.ts); a page's entity data comes with its game
 * render (renders.ts). No request inflates a blueprint. Also the print's own document, as the print
 * and render pages read it.
 */
import { error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { iconSet } from '#lib/server/icon-set.js';
import { gameData } from '#lib/server/pipeline/game-data.js';
import { rawKey } from '#lib/server/pipeline/pipeline.js';
import { readPrintDoc, type PrintDoc } from '#lib/server/pipeline/print-doc.js';
import { pageStringKey, parseViewerIndex, viewerIndexKey } from '#lib/server/pipeline/viewer-files.js';
import { getRenderPageData, getRenderSidecar, renderedPages } from '#lib/server/renders.js';
import { firstPagePath } from '#lib/viewer/extract.js';
import { pageBase } from '#lib/viewer/game-render.js';
import { parseModule } from '#lib/viewer/describe.js';
import type { CompactPage, PageRef, TooltipData } from '#lib/viewer/types.js';

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

/** Icons, English names and module slot counts for the names one page uses. */
export const tooltipData = (page: CompactPage): TooltipData => {
	const recipes = new Set<string>();
	const items = new Set<string>();
	const qualities = new Set<string>();
	for (const [, , , , x] of page.entities) {
		if (!x) continue;
		if (x.recipe) recipes.add(x.recipe);
		for (const q of [x.quality, x.recipeQuality]) if (q) qualities.add(q);
		for (const m of (x.modules ?? []).map(parseModule)) {
			items.add(m.name);
			if (m.quality) qualities.add(m.quality);
		}
		for (const f of x.filters ?? []) items.add(f);
	}
	const entities = page.names.map((n) => n.proto);
	const labelOf = (n: string) => gameData.entities[n]?.label ?? gameData.recipes[n]?.label ?? gameData.itemInfo[n]?.label;
	const labels: Record<string, string> = {};
	for (const n of [...entities, ...recipes, ...items]) {
		// The page data keeps recipe and item names as saved; an old one takes its current name's label, as icons do.
		const label = labelOf(n) ?? labelOf(gameData.migrate('recipe', n, [0, 0]));
		if (label) labels[n] = label;
	}
	const slots: Record<string, number> = {};
	for (const n of page.names) {
		const s = gameData.entities[n.proto]?.moduleSlots;
		if (s) slots[n.name] = s;
	}
	return { icons: iconSet({ entity: entities, recipe: recipes, item: items, quality: qualities }), labels, slots };
};

/**
 * The print's pages: the page list made at ingest, or when that's missing (or from another
 * VIEWER_VERSION) the pages its render index lists, so rendered pages still have a viewer.
 */
const pagesOf = async (id: string): Promise<PageRef[] | null> => {
	const index = parseViewerIndex(await read(viewerIndexKey(id)));
	if (index) return index.pages;
	const rendered = await renderedPages(id);
	if (!rendered.length) return null;
	return rendered.map((path) => ({ path, kind: 'blueprint', label: null, depth: path ? path.split('/').length : 0, entities: 0 }));
};

/**
 * One book page's game render with its entity data for hover tooltips (both made by the render
 * run, so their coordinates match). `requested` is a book path (as `listPages` writes it); anything
 * else falls back to the first blueprint. `page` and `render` are null when the page has no
 * render (or its data and sidecar are from different renders, mid-run). Null when the print has
 * no page list at all.
 */
export const loadViewerPage = async (id: string, requested: string | null) => {
	const pages = await pagesOf(id);
	if (pages === null) return null;
	const path = requested !== null && pages.some((p) => p.path === requested && p.kind === 'blueprint') ? requested : firstPagePath(pages);
	if (path === null) return { pages, path, page: null, render: null, tooltip: null };
	const [data, render] = await Promise.all([getRenderPageData(id, pageBase(path)), getRenderSidecar(id, pageBase(path))]);
	if (!data || !render || data.stamp !== render.stamp) return { pages, path, page: null, render: null, tooltip: null };
	return { pages, path, page: data.page, render, tooltip: tooltipData(data.page) };
};

/** Whether the print was taken down on request (`print_tombstones`, migration 0021): one primary-key read. */
export const takenDown = async (id: string) =>
	(await env.DB.prepare(`SELECT 1 AS hit FROM print_tombstones WHERE print_id = ? AND kind = 'takedown'`).bind(id).first()) !== null;

/**
 * The print's document (`analysis/<id>.json`) read together with `alongside`, another R2 read; the
 * 410 page when it was taken down on request, even if R2 still holds the document (a takedown cut short,
 * or an ingest that raced it), else the 404 page when there is no such print. The tombstone is read
 * alongside the R2 reads, so it adds one D1 read but no wait; it runs only when the page cache misses
 * (hooks.server.ts answers hits before any load runs).
 */
export const loadPrintDoc = async <T>(id: string, alongside: Promise<T>): Promise<[PrintDoc, T]> => {
	const [doc, other, removed] = await Promise.all([readPrintDoc(env.RAW, id), alongside, takenDown(id)]);
	if (removed) error(410, 'Removed on request');
	if (!doc) error(404, 'Print not found');
	return [doc, other];
};

/** The print's texts that may hold rich-text icons, for iconSet: its title and every page's label. */
export const printTexts = ({ print, analysis }: PrintDoc) => [print.title, ...analysis.nodes.map((n) => n.label)];
