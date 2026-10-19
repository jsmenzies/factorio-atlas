/**
 * Game-look renders made offline by scripts/render-game.ts (fpsr). This is the sidecar
 * format and the pure maths the viewer needs to place them: which level to draw at a given
 * zoom, and where each tile sits in world (tile) coordinates.
 *
 * Files per page, keyed `<print id>/<page path or "root">`:
 *   <base>.webp                    overview, whole page in one image
 *   <base>.json                    RenderSidecar
 *   <base>.tiles/<ppt>/<c>-<r>.webp  512 px tiles at higher detail (big pages only)
 * plus `<print id>/index.json` (RenderIndex) listing the pages that have renders.
 */

export const TILE_PX = 512;

export interface RenderLevel {
	/** Pixels per world tile. */
	ppt: number;
	/** Full level size in pixels; tiles on the right and bottom edges are smaller. */
	width: number;
	height: number;
	cols: number;
	rows: number;
}

export interface RenderSidecar {
	v: 1;
	id: string;
	path: string;
	/** Asset bundle that drew it: game version, render-db hash, placeholder or real sprites. */
	assets: { id: string; gameVersion: string; placeholder: boolean };
	fpsr: string;
	/** Changes on every render; appended to image URLs so they can be cached forever. */
	stamp: string;
	renderedAt: string;
	/**
	 * World tiles the images cover, in the viewer's coordinates (the page's `offset` was
	 * applied to the blueprint before rendering). pixel = (world - min) × ppt.
	 */
	frame: { minX: number; minY: number; maxX: number; maxY: number };
	offset: [number, number];
	overview: { width: number; height: number; ppt: number };
	tile: number;
	levels: RenderLevel[];
	altMode: boolean;
	stats: { entities: number; unknown: Record<string, number>; ms: number; bytes: number; files: number };
}

export interface RenderIndex {
	v: 1;
	/** First blueprint page; its overview is the print's thumbnail. */
	cover: string | null;
	pages: Record<string, { stamp: string; placeholder: boolean }>;
}

/** File base for a page path: "" → "root", "3/1" stays "3/1". */
export const pageBase = (path: string) => path || 'root';

/** Book paths are index numbers joined by "/"; anything else is not a render file. */
export const RENDER_FILE = /^(root|\d+(?:\/\d+)*)(\.webp|\.json|\.tiles\/\d+\/\d+-\d+\.webp)$|^index\.json$/;

export const overviewFile = (sc: Pick<RenderSidecar, 'path'>) => `${pageBase(sc.path)}.webp`;
export const tileFile = (sc: Pick<RenderSidecar, 'path'>, ppt: number, col: number, row: number) =>
	`${pageBase(sc.path)}.tiles/${ppt}/${col}-${row}.webp`;

/**
 * The level to draw at `devicePxPerTile` (zoom × devicePixelRatio): the coarsest one at
 * least that sharp, else the sharpest. Null means the overview is sharp enough on its own.
 */
export const pickLevel = (sc: Pick<RenderSidecar, 'overview' | 'levels'>, devicePxPerTile: number): RenderLevel | null => {
	if (sc.overview.ppt >= devicePxPerTile * 0.9 || !sc.levels.length) return null;
	const sorted = [...sc.levels].sort((a, b) => a.ppt - b.ppt);
	return sorted.find((l) => l.ppt >= devicePxPerTile * 0.9) ?? sorted[sorted.length - 1];
};

/** World rect of one tile. */
export const tileRect = (sc: Pick<RenderSidecar, 'frame' | 'tile'>, level: RenderLevel, col: number, row: number) => {
	const w = Math.min(sc.tile, level.width - col * sc.tile);
	const h = Math.min(sc.tile, level.height - row * sc.tile);
	const x = sc.frame.minX + (col * sc.tile) / level.ppt;
	const y = sc.frame.minY + (row * sc.tile) / level.ppt;
	return { x, y, w: w / level.ppt, h: h / level.ppt };
};

/** Tiles of `level` overlapping the world rect [x0, x1) × [y0, y1). */
export const visibleTiles = (
	sc: Pick<RenderSidecar, 'frame' | 'tile'>,
	level: RenderLevel,
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
