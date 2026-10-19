/**
 * Turns a compact page into batched Canvas2D paths, built once per page. Paths live in
 * world (tile) coordinates and are bucketed into 32×32-tile cells so a frame only touches
 * what's on screen. Browser-only (Path2D); the pure geometry lives in geometry.ts.
 */
import {
	beltShapes,
	cellsOf,
	dirVec,
	footprint,
	guessUnknownSizes,
	inserterHands,
	isCardinal,
	offsetLine,
	opposite,
	pairUndergrounds,
	pipeNetwork,
	railLine,
	tileKey,
	toGeo,
	turn,
	type BeltShape,
	type GeoEntity,
	type PipeNetwork,
	type Vec
} from './geometry.js';
import { FLUID_SPECS, beltTier } from './prototypes.js';
import type { Category, CompactPage } from './types.js';

export type Toggle = 'tiles' | 'wires' | 'grid' | 'labels';

export interface Style {
	mode: 'fill' | 'stroke';
	/** Draw layer; 0 is the tile layer. */
	layer?: number;
	color: string;
	width?: number;
	dash?: number[];
	alpha?: number;
	cap?: CanvasLineCap;
	toggle?: Toggle;
}

const CAT_FILL: Record<Category, string> = {
	belts: '#3a3320',
	inserters: '#3a3320',
	production: '#1c3350',
	power: '#3d3713',
	logistics: '#3b2d1b',
	circuits: '#123a2d',
	rail: '#2b2b31',
	defence: '#401a1a',
	other: '#2a2927',
	unknown: '#34343a'
};
const CAT_STROKE: Record<Category, string> = {
	belts: '#e3b341',
	inserters: '#eab308',
	production: '#6aa7ee',
	power: '#facc15',
	logistics: '#d6a76b',
	circuits: '#34d399',
	rail: '#a1a1aa',
	defence: '#f87171',
	other: '#a8a29e',
	unknown: '#9ca3af'
};
export const CATEGORY_COLOURS = CAT_STROKE;

const TIER: Record<ReturnType<typeof beltTier>, string> = {
	basic: '#e3b341',
	fast: '#e5534b',
	express: '#4aa8f0',
	turbo: '#6bd66f',
	other: '#d4d4d8'
};

const inserterColour = (name: string) =>
	name.startsWith('burner')
		? '#b07a3a'
		: name.startsWith('long')
			? '#ef4444'
			: name.startsWith('fast') || name.startsWith('filter')
				? '#60a5fa'
				: name.startsWith('bulk') || name.startsWith('stack')
					? '#4ade80'
					: '#eab308';

const TILE_COLOURS: [RegExp, string][] = [
	[/hazard/, '#3a3220'],
	[/refined-concrete/, '#2f3133'],
	[/concrete/, '#2a2b2c'],
	[/stone-path/, '#2b2925'],
	[/landfill/, '#2b261d'],
	[/space-platform-foundation/, '#1f232b'],
	[/foundation/, '#252429']
];
const tileColour = (name: string) => TILE_COLOURS.find(([re]) => re.test(name))?.[1] ?? '#262626';

const PIPE = '#7fa7c4';
const FLUID_IN = '#38bdf8';
const FLUID_OUT = '#fb923c';
const WIRE = ['#ef4444', '#22c55e', '#c2773a'];

/** Ordered style registry; draw order is registration order within each layer. */
class Styles {
	list: Style[] = [];
	private index = new Map<string, number>();
	private layerOf: number[] = [];
	id(key: string, layer: number, make: () => Style): number {
		let i = this.index.get(key);
		if (i === undefined) {
			i = this.list.length;
			this.list.push({ ...make(), layer });
			this.index.set(key, i);
			this.layerOf.push(layer);
		}
		return i;
	}
	/** Style ids sorted by layer, then registration. */
	order(): number[] {
		return this.list.map((_, i) => i).sort((a, b) => this.layerOf[a] - this.layerOf[b] || a - b);
	}
}

export interface Label {
	x: number;
	y: number;
	/** World-space box the text should fit in. */
	w: number;
	h: number;
	text: string;
	colour: string;
}

export interface Bucket {
	bx: number;
	by: number;
	paths: (Path2D | undefined)[];
	labels: Label[];
}

export interface Scene {
	geo: GeoEntity[];
	shapes: BeltShape[];
	undergroundPartner: Int32Array;
	pipes: PipeNetwork;
	styles: Style[];
	order: number[];
	buckets: Bucket[];
	/** Paths that are never culled (wires). */
	global: (Path2D | undefined)[];
	/** Tile → entity index for hover. */
	hit: Map<number, number>;
	bounds: { x0: number; y0: number; x1: number; y1: number };
}

export const BUCKET = 32;
/** Drawn shapes reach this far from their bucket (underground links, ramps, inserter arms). */
export const BUCKET_MARGIN = 16;

const L = { tiles: 0, body: 1, rail: 2, pipe: 3, belt: 4, beltTop: 5, inserter: 6, marks: 7, wires: 8 };

const prettify = (s: string) => s.replace(/-/g, ' ');

export const buildScene = (page: CompactPage): Scene => {
	const geo = toGeo(page);
	guessUnknownSizes(geo);
	const shapes = beltShapes(geo);
	const partner = pairUndergrounds(geo);
	const pipes = pipeNetwork(geo);
	const styles = new Styles();
	const buckets = new Map<string, Bucket>();
	const global: (Path2D | undefined)[] = [];

	const bucketAt = (x: number, y: number): Bucket => {
		const bx = Math.floor(x / BUCKET);
		const by = Math.floor(y / BUCKET);
		const k = `${bx},${by}`;
		let b = buckets.get(k);
		if (!b) buckets.set(k, (b = { bx, by, paths: [], labels: [] }));
		return b;
	};
	const pathIn = (b: Bucket, style: number) => (b.paths[style] ??= new Path2D());
	const pathGlobal = (style: number) => (global[style] ??= new Path2D());

	const fill = (key: string, layer: number, color: string, extra: Partial<Style> = {}) =>
		styles.id(`f:${key}`, layer, () => ({ mode: 'fill', color, ...extra }));
	const stroke = (key: string, layer: number, color: string, width: number, extra: Partial<Style> = {}) =>
		styles.id(`s:${key}`, layer, () => ({ mode: 'stroke', color, width, cap: 'round', ...extra }));

	// Bounds over entities and tiles.
	let x0 = Infinity,
		y0 = Infinity,
		x1 = -Infinity,
		y1 = -Infinity;
	const extend = (ax: number, ay: number, bx: number, by: number) => {
		x0 = Math.min(x0, ax);
		y0 = Math.min(y0, ay);
		x1 = Math.max(x1, bx);
		y1 = Math.max(y1, by);
	};

	// --- tiles
	for (const t of page.tiles) {
		const s = fill(`tile:${t.name}`, L.tiles, tileColour(t.name), { toggle: 'tiles' });
		for (let i = 0; i < t.runs.length; i += 3) {
			let x = t.runs[i];
			const y = t.runs[i + 1];
			const end = x + t.runs[i + 2];
			extend(x, y, end, y + 1);
			// Split runs at bucket edges so culling stays exact.
			while (x < end) {
				const stop = Math.min(end, (Math.floor(x / BUCKET) + 1) * BUCKET);
				pathIn(bucketAt(x, y), s).rect(x, y, stop - x, 1);
				x = stop;
			}
		}
	}

	const hit = new Map<number, number>();
	// Big things first so small things on top win the hover.
	const hitOrder = geo.map((_, i) => i).sort((a, b) => geo[b].w * geo[b].h - geo[a].w * geo[a].h);
	for (const i of hitOrder) {
		const e = geo[i];
		const cells = e.kind.startsWith('rail-') || e.kind === 'vehicle' ? [[Math.floor(e.x), Math.floor(e.y)] as Vec] : cellsOf(e);
		for (const [tx, ty] of cells) hit.set(tileKey(tx, ty), i);
	}

	const tri = (p: Path2D, tip: Vec, dir: Vec, len: number, half: number) => {
		const [vx, vy] = dir;
		const bx = tip[0] - vx * len;
		const by = tip[1] - vy * len;
		p.moveTo(tip[0], tip[1]);
		p.lineTo(bx - vy * half, by + vx * half);
		p.lineTo(bx + vy * half, by - vx * half);
		p.closePath();
	};
	const circle = (p: Path2D, x: number, y: number, r: number) => {
		p.moveTo(x + r, y);
		p.arc(x, y, r, 0, Math.PI * 2);
	};
	const line = (p: Path2D, a: Vec, b: Vec) => {
		p.moveTo(a[0], a[1]);
		p.lineTo(b[0], b[1]);
	};
	const poly = (p: Path2D, pts: Vec[]) => {
		pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
	};
	const at = (e: GeoEntity, d: number, k: number): Vec => {
		const [vx, vy] = dirVec(d);
		return [e.x + vx * k, e.y + vy * k];
	};
	const rectPath = (p: Path2D, e: GeoEntity, inset: number) => {
		const [w, h] = footprint(e.w, e.h, e.dir);
		p.rect(e.x - w / 2 + inset, e.y - h / 2 + inset, Math.max(0.05, w - 2 * inset), Math.max(0.05, h - 2 * inset));
	};

	const label = (b: Bucket, e: GeoEntity, text: string, colour = '#e7e5e4') => {
		const [w, h] = footprint(e.w, e.h, e.dir);
		b.labels.push({ x: e.x, y: e.y, w, h, text, colour });
	};

	geo.forEach((e, i) => {
		const b = bucketAt(e.x, e.y);
		const [fw, fh] = footprint(e.w, e.h, e.dir);
		extend(e.x - fw / 2, e.y - fh / 2, e.x + fw / 2, e.y + fh / 2);
		const info = page.names[page.entities[i][0]];
		const tierColour = TIER[beltTier(e.name)];
		const v = dirVec(e.dir);

		switch (e.kind) {
			case 'belt': {
				const band = stroke(`band:${tierColour}`, L.belt, tierColour, 0.72, { alpha: 0.2, cap: 'butt' });
				const arrow = stroke(`arrow:${tierColour}`, L.beltTop, tierColour, 0.09);
				const head = fill(`head:${tierColour}`, L.beltTop, tierColour);
				const shape = shapes[i];
				if (shape === 0 || !isCardinal(e.dir)) {
					line(pathIn(b, band), at(e, opposite(e.dir), 0.5), at(e, e.dir, 0.5));
					line(pathIn(b, arrow), at(e, opposite(e.dir), 0.5), at(e, e.dir, 0.1));
					tri(pathIn(b, head), at(e, e.dir, 0.32), v, 0.3, 0.2);
				} else {
					// Quarter circle around the corner shared by the entry side and the exit side.
					const side = turn(e.dir, shape * 4);
					const [sx, sy] = dirVec(side);
					const cx = e.x + (sx + v[0]) * 0.5;
					const cy = e.y + (sy + v[1]) * 0.5;
					const a0 = Math.atan2(-v[1], -v[0]);
					const a1 = Math.atan2(-sy, -sx);
					let delta = a1 - a0;
					while (delta <= -Math.PI) delta += 2 * Math.PI;
					while (delta > Math.PI) delta -= 2 * Math.PI;
					const ccw = delta < 0;
					const bp = pathIn(b, band);
					bp.moveTo(cx + Math.cos(a0) * 0.5, cy + Math.sin(a0) * 0.5);
					bp.arc(cx, cy, 0.5, a0, a1, ccw);
					const ap = pathIn(b, arrow);
					ap.moveTo(cx + Math.cos(a0) * 0.5, cy + Math.sin(a0) * 0.5);
					ap.arc(cx, cy, 0.5, a0, a0 + delta * 0.55, ccw);
					// Head on the arc, pointing along the direction of travel.
					const at_ = a0 + delta * 0.85;
					const sgn = Math.sign(delta);
					tri(pathIn(b, head), [cx + Math.cos(at_) * 0.5, cy + Math.sin(at_) * 0.5], [-Math.sin(at_) * sgn, Math.cos(at_) * sgn], 0.3, 0.2);
				}
				break;
			}
			case 'underground': {
				const band = stroke(`band:${tierColour}`, L.belt, tierColour, 0.72, { alpha: 0.2, cap: 'butt' });
				const gate = stroke(`gate:${tierColour}`, L.beltTop, tierColour, 0.16, { cap: 'butt' });
				const head = fill(`head:${tierColour}`, L.beltTop, tierColour);
				const arrow = stroke(`arrow:${tierColour}`, L.beltTop, tierColour, 0.09);
				const p = partner[i];
				const perp = dirVec(turn(e.dir, 4));
				const gateAt = (k: number) => {
					const c = at(e, e.dir, k);
					line(pathIn(b, gate), [c[0] - perp[0] * 0.42, c[1] - perp[1] * 0.42], [c[0] + perp[0] * 0.42, c[1] + perp[1] * 0.42]);
				};
				if (e.io === 'in') {
					line(pathIn(b, band), at(e, opposite(e.dir), 0.5), at(e, e.dir, 0.2));
					line(pathIn(b, arrow), at(e, opposite(e.dir), 0.4), at(e, e.dir, 0.0));
					tri(pathIn(b, head), at(e, e.dir, 0.18), v, 0.3, 0.22);
					gateAt(0.3);
				} else {
					line(pathIn(b, band), at(e, opposite(e.dir), 0.2), at(e, e.dir, 0.5));
					line(pathIn(b, arrow), at(e, opposite(e.dir), 0.05), at(e, e.dir, 0.2));
					tri(pathIn(b, head), at(e, e.dir, 0.47), v, 0.32, 0.22);
					gateAt(-0.3);
				}
				if (p >= 0 && e.io === 'in') {
					const link = stroke(`ulink:${tierColour}`, L.belt, tierColour, 0.07, { alpha: 0.45, dash: [0.25, 0.2], cap: 'butt' });
					line(pathIn(b, link), at(e, e.dir, 0.45), at(geo[p], opposite(e.dir), 0.45));
				} else if (p < 0) {
					const warn = stroke('unpaired', L.marks, '#f43f5e', 0.08);
					circle(pathIn(b, warn), e.x, e.y, 0.42);
				}
				break;
			}
			case 'splitter':
			case 'loader': {
				const body = fill(`sbody:${tierColour}`, L.belt, tierColour, { alpha: 0.18 });
				const edge = stroke(`sedge:${tierColour}`, L.beltTop, tierColour, 0.08);
				const arrow = stroke(`arrow:${tierColour}`, L.beltTop, tierColour, 0.09);
				const head = fill(`head:${tierColour}`, L.beltTop, tierColour);
				rectPath(pathIn(b, body), e, 0.06);
				rectPath(pathIn(b, edge), e, 0.06);
				const lanes = cellsOf(e).map(([tx, ty]) => [tx + 0.5, ty + 0.5] as Vec);
				if (e.kind === 'loader') lanes.splice(0, lanes.length, [e.x, e.y]);
				const reach = e.kind === 'loader' ? Math.max(fw, fh) / 2 : 0.5;
				for (const [lx, ly] of lanes) {
					const from: Vec = [lx - v[0] * (reach - 0.1), ly - v[1] * (reach - 0.1)];
					const to: Vec = [lx + v[0] * (reach - 0.3), ly + v[1] * (reach - 0.3)];
					line(pathIn(b, arrow), from, to);
					tri(pathIn(b, head), [lx + v[0] * (reach - 0.03), ly + v[1] * (reach - 0.03)], v, 0.3, 0.2);
				}
				if (e.kind === 'splitter') {
					const pri = fill('priority', L.marks, '#f8fafc');
					const left = dirVec(turn(e.dir, -4));
					const mark = (side: 'left' | 'right', k: number) => {
						const s = side === 'left' ? 1 : -1;
						const c: Vec = [e.x + left[0] * 0.5 * s + v[0] * k, e.y + left[1] * 0.5 * s + v[1] * k];
						pathIn(b, pri).moveTo(c[0] + 0.13, c[1]);
						pathIn(b, pri).arc(c[0], c[1], 0.13, 0, Math.PI * 2);
					};
					if (e.extra?.inPri) mark(e.extra.inPri, -0.3);
					if (e.extra?.outPri) mark(e.extra.outPri, 0.3);
					if (e.extra?.filter) label(b, e, prettify(e.extra.filter), '#f8fafc');
				}
				break;
			}
			case 'inserter': {
				const colour = inserterColour(e.name);
				const arm = stroke(`arm:${colour}`, L.inserter, colour, 0.08, { alpha: 0.85 });
				const head = fill(`ihead:${colour}`, L.inserter, colour);
				const body = fill(`ibody:${colour}`, L.inserter, colour, { alpha: 0.55 });
				const { pickup, drop } = inserterHands(e);
				const dx = drop[0] - pickup[0];
				const dy = drop[1] - pickup[1];
				const len = Math.hypot(dx, dy) || 1;
				const u: Vec = [dx / len, dy / len];
				pathIn(b, body).rect(e.x - 0.17, e.y - 0.17, 0.34, 0.34);
				line(pathIn(b, arm), pickup, [drop[0] - u[0] * 0.2, drop[1] - u[1] * 0.2]);
				const pp = pathIn(b, head);
				pp.moveTo(pickup[0] + 0.09, pickup[1]);
				pp.arc(pickup[0], pickup[1], 0.09, 0, Math.PI * 2);
				tri(pp, drop, u, 0.28, 0.17);
				break;
			}
			case 'pipe':
			case 'pipe-to-ground': {
				const pipe = stroke('pipe', L.pipe, PIPE, 0.3, { cap: 'butt' });
				const hub = fill('pipehub', L.pipe, PIPE);
				const sides = pipes.sides[i];
				const bits = [0, 4, 8, 12];
				bits.forEach((d, k) => {
					if (sides & (1 << k)) line(pathIn(b, pipe), [e.x, e.y], at(e, d, 0.5));
				});
				if (e.kind === 'pipe') {
					pathIn(b, hub).rect(e.x - 0.2, e.y - 0.2, 0.4, 0.4);
				} else {
					// Pipe-to-ground: stub toward the open side, a cap bar on the buried side.
					const cap = stroke('ptgcap', L.pipe, PIPE, 0.16, { cap: 'butt' });
					const perp = dirVec(turn(e.dir, 4));
					const c = at(e, opposite(e.dir), 0.25);
					line(pathIn(b, pipe), at(e, opposite(e.dir), 0.2), at(e, e.dir, 0.3));
					line(pathIn(b, cap), [c[0] - perp[0] * 0.38, c[1] - perp[1] * 0.38], [c[0] + perp[0] * 0.38, c[1] + perp[1] * 0.38]);
					const p = pipes.underground[i];
					if (p > i) {
						const link = stroke('pipelink', L.pipe, PIPE, 0.07, { alpha: 0.4, dash: [0.25, 0.2], cap: 'butt' });
						line(pathIn(b, link), at(e, opposite(e.dir), 0.4), at(geo[p], opposite(geo[p].dir), 0.4));
					} else if (p < 0) {
						const warn = stroke('unpaired', L.marks, '#f43f5e', 0.08);
						circle(pathIn(b, warn), e.x, e.y, 0.42);
					}
				}
				break;
			}
			case 'rail-straight':
			case 'rail-half-diagonal':
			case 'rail-curve-a':
			case 'rail-curve-b':
			case 'rail-legacy-straight':
			case 'rail-legacy-curve': {
				const pts = railLine(e);
				if (!pts) break;
				const bed = stroke('railbed', L.rail, '#3f3a35', 1.5, { cap: 'butt' });
				const rail = stroke('rail', L.rail, '#b4b4bb', 0.09, { cap: 'butt' });
				poly(pathIn(b, bed), pts);
				poly(pathIn(b, rail), offsetLine(pts, 0.38));
				poly(pathIn(b, rail), offsetLine(pts, -0.38));
				for (const [x, y] of pts) extend(x - 1, y - 1, x + 1, y + 1);
				break;
			}
			case 'signal': {
				const colour = e.name.includes('chain') ? '#60a5fa' : '#4ade80';
				const s = fill(`sig:${colour}`, L.marks, colour);
				const tick = stroke(`sigtick:${colour}`, L.marks, colour, 0.08);
				pathIn(b, s).moveTo(e.x + 0.3, e.y);
				pathIn(b, s).arc(e.x, e.y, 0.3, 0, Math.PI * 2);
				line(pathIn(b, tick), [e.x, e.y], at(e, e.dir, 0.55));
				break;
			}
			case 'vehicle': {
				const s = fill('vehicle', L.body, CAT_FILL.rail);
				const edge = stroke('vehicleedge', L.body, CAT_STROKE.rail, 0.08);
				const a = (e.extra?.orientation ?? 0) * Math.PI * 2;
				const corners: Vec[] = [
					[-0.75, -2.8],
					[0.75, -2.8],
					[0.75, 2.8],
					[-0.75, 2.8]
				].map(([x, y]) => [e.x + x * Math.cos(a) - y * Math.sin(a), e.y + x * Math.sin(a) + y * Math.cos(a)]);
				poly(pathIn(b, s), corners);
				pathIn(b, s).closePath();
				poly(pathIn(b, edge), corners);
				pathIn(b, edge).closePath();
				label(b, e, prettify(e.name), CAT_STROKE.rail);
				break;
			}
			default: {
				// Buildings and everything else: category box, label, direction notch, fluid ports.
				const cat = info.category;
				const dashed = e.known === false;
				const body = fill(`body:${cat}`, L.body, CAT_FILL[cat]);
				const edge = stroke(`edge:${cat}${dashed ? ':d' : ''}`, L.body, CAT_STROKE[cat], 0.07, {
					cap: 'butt',
					...(dashed ? { dash: [0.2, 0.15] } : {})
				});
				const inset = fw * fh > 1 ? 0.08 : 0.12;
				if (e.name === 'offshore-pump') {
					// 2.0 sizes it 2×2 from its collision box; it really is one tile plus a water tab.
					const p = pathIn(b, body);
					p.rect(e.x - 0.4, e.y - 0.4, 0.8, 0.8);
					rectPath(pathIn(b, edge), { ...e, w: 0.8, h: 0.8 }, 0);
					const tab = at(e, opposite(e.dir), 0.75);
					line(pathIn(b, stroke('water', L.body, '#38bdf8', 0.3, { cap: 'butt' })), at(e, opposite(e.dir), 0.4), tab);
				} else {
					rectPath(pathIn(b, body), e, inset);
					rectPath(pathIn(b, edge), e, inset);
				}
				const spec = FLUID_SPECS[e.name];
				const rotatable =
					(!!spec && (!spec.recipeGated || e.fluid)) ||
					/^(mining-drill|boiler|generator|asteroid-collector|pump|fusion-reactor|fusion-generator|thruster)$/.test(info.type ?? '');
				if (rotatable && fw * fh > 1 && isCardinal(e.dir)) {
					const notch = fill(`notch:${cat}`, L.marks, CAT_STROKE[cat]);
					const depth = Math.min(fw, fh) / 2;
					tri(pathIn(b, notch), at(e, e.dir, depth - inset - 0.02), v, 0.35, 0.3);
				}
				for (const pi of pipes.portsOf[i]) {
					const port = pipes.ports[pi];
					const pv = dirVec(port.dir);
					const edgeX = port.tx + 0.5 + pv[0] * 0.5;
					const edgeY = port.ty + 0.5 + pv[1] * 0.5;
					const colour = port.flow === 'in' ? FLUID_IN : port.flow === 'out' ? FLUID_OUT : PIPE;
					const joined = port.joined !== -1;
					const s = stroke(`port:${colour}:${joined}`, L.marks, colour, joined ? 0.3 : 0.18, {
						cap: 'butt',
						alpha: joined ? 1 : 0.7
					});
					line(
						pathIn(b, s),
						[edgeX - pv[0] * 0.3, edgeY - pv[1] * 0.3],
						[edgeX + pv[0] * (joined ? 0.08 : 0.04), edgeY + pv[1] * (joined ? 0.08 : 0.04)]
					);
				}
				const text = e.extra?.recipe
					? prettify(e.extra.recipe)
					: e.extra?.text
						? e.extra.text
						: e.known === false
							? e.name
							: e.kind === 'train-stop'
								? 'train stop'
								: fw * fh >= 4
									? prettify(e.name)
									: '';
				if (text) label(b, e, text, e.extra?.recipe ? '#f5f5f4' : '#a8a29e');
				break;
			}
		}
	});

	// --- wires (global, toggled)
	for (const [a, c, colour] of page.wires) {
		const s = stroke(`wire:${colour}`, L.wires, WIRE[colour], 0.06, { toggle: 'wires', alpha: 0.85 });
		const off = colour === 0 ? -0.12 : colour === 1 ? 0.12 : 0;
		const p = pathGlobal(s);
		p.moveTo(geo[a].x + off, geo[a].y + off);
		p.lineTo(geo[c].x + off, geo[c].y + off);
	}

	if (!Number.isFinite(x0)) [x0, y0, x1, y1] = [-5, -5, 5, 5];
	return {
		geo,
		shapes,
		undergroundPartner: partner,
		pipes,
		styles: styles.list,
		order: styles.order(),
		buckets: [...buckets.values()],
		global,
		hit,
		bounds: { x0, y0, x1, y1 }
	};
};
