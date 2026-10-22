/**
 * What the viewer needs to inspect a page drawn as a game render: each entity's geometry, a
 * tile → entity map for hover, and the belt, underground and pipe context the tooltip shows.
 * Built once per page; pure, so `bun test` can run it.
 */
import {
	beltShapes,
	cellsOf,
	footprint,
	guessUnknownSizes,
	pairUndergrounds,
	pipeNetwork,
	tileKey,
	toGeo,
	type BeltShape,
	type GeoEntity,
	type PipeNetwork,
	type Vec
} from './geometry.js';
import type { CompactPage } from './types.js';

export interface Inspector {
	geo: GeoEntity[];
	shapes: BeltShape[];
	undergroundPartner: Int32Array;
	pipes: PipeNetwork;
	/** Tile (`tileKey`) → entity index for hover. */
	hit: Map<number, number>;
	/** Entity extent in world tiles, for fitting the view; null without entities. */
	bounds: { x0: number; y0: number; x1: number; y1: number } | null;
}

export const buildInspector = (page: CompactPage): Inspector => {
	const geo = toGeo(page);
	guessUnknownSizes(geo);
	let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
	for (const e of geo) {
		const [w, h] = footprint(e.w, e.h, e.dir);
		x0 = Math.min(x0, e.x - w / 2);
		y0 = Math.min(y0, e.y - h / 2);
		x1 = Math.max(x1, e.x + w / 2);
		y1 = Math.max(y1, e.y + h / 2);
	}
	const bounds = geo.length ? { x0, y0, x1, y1 } : null;
	const hit = new Map<number, number>();
	// Big things first so small things on top win the hover.
	const order = geo.map((_, i) => i).sort((a, b) => geo[b].w * geo[b].h - geo[a].w * geo[a].h);
	for (const i of order) {
		const e = geo[i];
		const cells = e.kind.startsWith('rail-') || e.kind === 'vehicle' ? [[Math.floor(e.x), Math.floor(e.y)] as Vec] : cellsOf(e);
		for (const [tx, ty] of cells) hit.set(tileKey(tx, ty), i);
	}
	return { geo, shapes: beltShapes(geo), undergroundPartner: pairUndergrounds(geo), pipes: pipeNetwork(geo), hit, bounds };
};
