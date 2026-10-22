/**
 * A blueprint page as the runner hands it to a worker: why it is skipped, if it is, and otherwise
 * its JSON as fpsr draws it and its entity data for the hover tooltips. The JSON is what a page's
 * input key hashes (settings.ts `inputKey`), so what these functions return for a page must never
 * change without a reason to redraw every page (RENDER_SETTINGS_VERSION).
 */
import { migrateTo2x, type Blueprint, type RenderDb } from '@rickyzhangca/fpsr';
import { extractPage, type Catalog } from '#lib/viewer/extract.js';
import type { CompactPage } from '#lib/viewer/types.js';
import { versionSkip } from './scope.js';
import { versionString, type BlueprintPage } from './source.js';

type Json = Record<string, unknown>;

export interface Prepared {
	/** The page as it goes to fpsr. */
	json: string;
	/** The viewer offset applied to it. */
	offset: [number, number];
	/** Its CompactPage JSON, for `<base>.page.json`: the same coordinates as the render. */
	page: string;
}

export const entityCount = (page: BlueprintPage) => (Array.isArray(page.blueprint.entities) ? page.blueprint.entities.length : 0);

/** Move entities by the viewer's half-tile fix (#lib/viewer/extract.js alignToGrid) so render and hover share one world. */
export const shifted = (bp: Json, [sx, sy]: [number, number]): Json =>
	!sx && !sy
		? bp
		: {
				...bp,
				entities: ((bp.entities ?? []) as Json[]).map((e) => {
					const p = e.position as { x: number; y: number };
					return { ...e, position: { x: p.x + sx, y: p.y + sy } };
				})
			};

/** The page's entity and tile names fpsr's render db has no sprites for, sorted. */
export const moddedNames = (db: Pick<RenderDb, 'entities' | 'tiles'>, bp: Json): string[] => {
	const names = new Set<string>();
	for (const e of migrateTo2x(bp as unknown as Blueprint).entities ?? []) if (!db.entities[e.name]) names.add(e.name);
	for (const t of Array.isArray(bp.tiles) ? (bp.tiles as { name?: unknown }[]) : [])
		if (typeof t.name === 'string' && !db.tiles[t.name]) names.add(t.name);
	return [...names].sort();
};

/**
 * Why the page isn't drawn ('pre-2.0', 'empty', 'modded: …'), or null. `favorite`: the print is in
 * render_favorites, so pages saved before 2.0 are drawn too.
 */
export const skipReason = (db: Pick<RenderDb, 'entities' | 'tiles'>, page: BlueprintPage, favorite: boolean): string | null => {
	const old = versionSkip(page.version, favorite);
	if (old) return old;
	const ents = Array.isArray(page.blueprint.entities) ? page.blueprint.entities.length : 0;
	const tiles = Array.isArray(page.blueprint.tiles) ? page.blueprint.tiles.length : 0;
	if (!ents && !tiles) return 'empty';
	const names = moddedNames(db, page.blueprint);
	if (names.length) return `modded: ${names.slice(0, 12).join(', ')}${names.length > 12 ? `, … (${names.length})` : ''}`;
	return null;
};

/** What a skipped page's row is keyed by: its blueprint as decoded, unshifted, with no page data. */
export const preparedSkipped = (page: BlueprintPage): Prepared => ({ json: JSON.stringify(page.blueprint), offset: [0, 0], page: '' });

/** The page as it goes to fpsr, the viewer offset applied to it, and its entity data for hover tooltips. */
export const prepared = (catalog: Catalog, decoded: unknown, page: BlueprintPage): Prepared => {
	const compact: CompactPage = extractPage(decoded, page.path, catalog) ?? {
		path: page.path,
		label: page.label,
		description: null,
		gameVersion: versionString(page.version),
		sourceDirections: 16,
		names: [],
		entities: []
	};
	const offset = compact.offset ?? [0, 0];
	return { json: JSON.stringify(shifted(page.blueprint, offset)), offset, page: JSON.stringify(compact) };
};

/**
 * Prepared pages kept between queueing and drawing, up to `maxBytes` of JSON, so a small run
 * decodes each print once. A page leaves the cache when it is taken.
 */
export class PageCache {
	private readonly pages = new Map<string, Prepared>();
	private size = 0;

	constructor(private readonly maxBytes: number) {}

	/** Bytes held. */
	get bytes() {
		return this.size;
	}

	/** Keep the page if it fits; false when it doesn't. */
	offer(id: string, path: string, p: Prepared): boolean {
		const k = `${id}\n${path}`;
		const old = this.pages.get(k);
		const n = PageCache.sizeOf(p) - (old ? PageCache.sizeOf(old) : 0);
		if (this.size + n >= this.maxBytes) return false;
		this.pages.set(k, p);
		this.size += n;
		return true;
	}

	/** The page, removed from the cache; undefined when it isn't held. */
	take(id: string, path: string): Prepared | undefined {
		const k = `${id}\n${path}`;
		const p = this.pages.get(k);
		if (p === undefined) return undefined;
		this.pages.delete(k);
		this.size -= PageCache.sizeOf(p);
		return p;
	}

	private static sizeOf(p: Prepared) {
		return p.json.length + p.page.length;
	}
}
