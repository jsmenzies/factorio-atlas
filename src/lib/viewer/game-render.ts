/**
 * Game-look renders made offline by scripts/render-game.ts (fpsr). This is the sidecar
 * format and the pure maths the viewer needs to place them: which level to draw at a given
 * zoom, and where each tile sits in world (tile) coordinates.
 *
 * Files per print, under `<print id>/`:
 *   <base>.<stamp>.avif  overview of one page (`<base>` is its book path, or "root"), whole page in one
 *                      image; named by the render's stamp, so a re-render gets a new name
 *   <base>.json        RenderSidecar (v2): frame, levels and each level's tile map
 *   <base>.page.json   RenderPageData: the page's entities in the render's coordinates, for hover tooltips
 *   t/<hash>.avif      512 px tiles, stored once per print by pixel hash and shared by every
 *                      page and level that has the same pixels
 *   index.json         RenderIndex: the pages that have renders
 */

import type { CompactPage } from './types.js';

export const TILE_PX = 512;

/** Bump when extractPage's output (#lib/viewer/extract.js) changes: the next render run rewrites every page's data without redrawing. */
export const PAGE_DATA_VERSION = 1;

export interface RenderPageData {
	v: typeof PAGE_DATA_VERSION;
	/** The sidecar's stamp when written: a page whose data and sidecar disagree is mid-render and has no viewer. */
	stamp: string;
	page: CompactPage;
}

export interface RenderLevel {
	/** Pixels per world tile. */
	ppt: number;
	/** Full level size in pixels; tiles on the right and bottom edges are smaller. */
	width: number;
	height: number;
	cols: number;
	rows: number;
	/**
	 * Row-major `cols × rows` tile map: each tile's hash (its file is `t/<hash>.avif`), or ''
	 * for a fully transparent tile, which has no file.
	 */
	tiles: string[];
}

export interface RenderSidecar {
	v: 2;
	id: string;
	path: string;
	/** sha256 of everything that decides the pixels: the page as rendered, the assets, fpsr and the settings. */
	inputKey: string;
	/** Asset bundle that drew it: game version and render-db hash. */
	assets: { id: string; gameVersion: string };
	fpsr: string;
	/** Changes when the render's input does; appended to the overview URL so it can be cached forever. */
	stamp: string;
	renderedAt: string;
	/**
	 * World tiles the images cover, in the viewer's coordinates (the page's `offset` was
	 * applied to the blueprint before rendering). pixel = (world - min) × ppt.
	 */
	frame: { minX: number; minY: number; maxX: number; maxY: number };
	offset: [number, number];
	overview: { file: string; width: number; height: number; ppt: number };
	tile: number;
	levels: RenderLevel[];
	altMode: boolean;
	encoding: { format: 'avif'; quality: number; effort: number; chroma: string };
	/** PAGE_DATA_VERSION of the page's `<base>.page.json`; absent in renders made before it existed. */
	pageData?: number;
	stats: {
		entities: number;
		/** Entities fpsr has no sprites for; empty, since such pages are skipped. */
		unknown: Record<string, number>;
		ms: number;
		/** Files this render wrote, and their bytes without the sidecar's own (tiles already on disk aren't counted). */
		bytes: number;
		files: number;
		/**
		 * Tiles in the levels' maps: transparent ones (of which `unread` nothing could reach, so they
		 * were never drawn), ones already on disk, ones written now.
		 */
		tiles: { total: number; empty: number; reused: number; written: number; unread?: number };
		/** Where the render's wall time went, in ms: draw-list planning, the overview, drawing tile chunks, reading and hashing pixels, waiting on AVIF encodes. */
		time?: { plan: number; overview: number; draw: number; pixels: number; encodeWait: number };
	};
}

export interface RenderIndex {
	v: 2;
	/** First rendered blueprint page; its overview is the print's thumbnail. */
	cover: string | null;
	/** Per rendered page: the stamp its overview URL carries, and the overview file. */
	pages: Record<string, { stamp: string; overview: string }>;
}

/** File base for a page path: "" → "root", "3/1" stays "3/1". */
export const pageBase = (path: string) => path || 'root';

/** A tile hash: the first 16 hex digits of a sha256. */
export const TILE_HASH = /^[0-9a-f]{16}$/;

/** A render stamp: the first 10 hex digits of the page's input key. URL-safe; a re-render with other input gets another. */
export const STAMP = /^[0-9a-f]{10}$/;

/**
 * Book paths are index numbers joined by "/"; anything else is not a render file. Every .avif is
 * named by its content (tiles by pixel hash, overviews by stamp), so it never changes.
 */
export const RENDER_FILE = /^(?:(?:root|\d+(?:\/\d+)*)\.(?:[0-9a-f]{10}\.avif|json|page\.json)|t\/[0-9a-f]{16}\.avif|index\.json)$/;

/** The overview's name, `<base>.<stamp>.avif`: a re-render writes a new file, so a URL can be cached for good. */
export const overviewFile = (path: string, stamp: string) => `${pageBase(path)}.${stamp}.avif`;
export const sidecarFile = (path: string) => `${pageBase(path)}.json`;
export const pageDataFile = (path: string) => `${pageBase(path)}.page.json`;
export const tileHashFile = (hash: string) => `t/${hash}.avif`;

/**
 * Cache-Control for a render file (relative to its print), the same in the bucket and from the
 * Worker: images are named by content and never change; index.json changes as pages render;
 * sidecars and page data keep their names across re-renders.
 */
export const renderCacheControl = (file: string) =>
	file.endsWith('.avif') ? 'public, max-age=31536000, immutable' : file === 'index.json' ? 'public, max-age=60' : 'public, max-age=300';

/** The file for one tile of `level`, or null when the tile is transparent (or out of range). */
export const tileFile = (level: Pick<RenderLevel, 'cols' | 'rows' | 'tiles'>, col: number, row: number): string | null => {
	if (col < 0 || row < 0 || col >= level.cols || row >= level.rows) return null;
	const hash = level.tiles[row * level.cols + col];
	return hash ? tileHashFile(hash) : null;
};

/**
 * The level to draw at `devicePxPerTile` (zoom × devicePixelRatio): the coarsest one at
 * least that sharp, else the sharpest. Null means the overview is sharp enough on its own.
 */
export const pickLevel = <L extends Pick<RenderLevel, 'ppt'>>(
	sc: { overview: Pick<RenderSidecar['overview'], 'ppt'>; levels: L[] },
	devicePxPerTile: number
): L | null => {
	if (sc.overview.ppt >= devicePxPerTile * 0.9 || !sc.levels.length) return null;
	const sorted = [...sc.levels].sort((a, b) => a.ppt - b.ppt);
	return sorted.find((l) => l.ppt >= devicePxPerTile * 0.9) ?? sorted[sorted.length - 1];
};

/** Pixels per tile at which each level is drawn: every level sharper than the overview. */
export const levelsAbove = (overviewPpt: number, levels: readonly number[]) => levels.filter((l) => l > overviewPpt);

type LevelGeometry = Pick<RenderLevel, 'ppt' | 'width' | 'height' | 'cols' | 'rows'>;

/** World rect of one tile. */
export const tileRect = (sc: Pick<RenderSidecar, 'frame' | 'tile'>, level: LevelGeometry, col: number, row: number) => {
	const w = Math.min(sc.tile, level.width - col * sc.tile);
	const h = Math.min(sc.tile, level.height - row * sc.tile);
	const x = sc.frame.minX + (col * sc.tile) / level.ppt;
	const y = sc.frame.minY + (row * sc.tile) / level.ppt;
	return { x, y, w: w / level.ppt, h: h / level.ppt };
};

/** Tiles of `level` overlapping the world rect [x0, x1) × [y0, y1). */
export const visibleTiles = (
	sc: Pick<RenderSidecar, 'frame' | 'tile'>,
	level: LevelGeometry,
	x0: number,
	y0: number,
	x1: number,
	y1: number
): [number, number][] => {
	const span = sc.tile / level.ppt;
	const c0 = Math.max(0, Math.floor((x0 - sc.frame.minX) / span));
	const c1 = Math.min(level.cols - 1, Math.floor((x1 - sc.frame.minX) / span));
	const r0 = Math.max(0, Math.floor((y0 - sc.frame.minY) / span));
	const r1 = Math.min(level.rows - 1, Math.floor((y1 - sc.frame.minY) / span));
	const out: [number, number][] = [];
	for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push([c, r]);
	return out;
};
