/**
 * Pure geometry behind the viewer's hover tooltips over game renders: direction handling, belt
 * curves, underground pairing, pipe connectivity and inserter hands. No DOM, no Svelte, no game
 * data beyond the small tables in prototypes.ts, so `bun test` can run it.
 *
 * Coordinates are blueprint tiles: x grows east, y grows south, entity positions are
 * centres. Directions are 16-way (N = 0, E = 4, S = 8, W = 12) after normalisation.
 */
import {
	FLUID_SPECS,
	INSERTER_REACH,
	PIPE_TO_GROUND_MAX,
	UNDERGROUND_MAX,
	UNDERGROUND_MAX_DEFAULT,
	type FluidConnection
} from './prototypes.js';
import type { CompactPage, EntityExtra, Kind } from './types.js';

export type Vec = [number, number];

/**
 * Normalise a blueprint `direction` to 16-way. Pre-2.0 prints use 8 directions (east = 2),
 * 2.0 uses 16 (east = 4). A missing direction means north.
 */
export const normalizeDirection = (dir: number | undefined | null, major: number): number => {
	const d = typeof dir === 'number' && Number.isFinite(dir) ? Math.round(dir) : 0;
	return (((major < 2 ? d * 2 : d) % 16) + 16) % 16;
};

const DIR_NAMES = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const directionName = (d: number) => DIR_NAMES[((d % 16) + 16) % 16];

export const turn = (d: number, by: number) => (((d + by) % 16) + 16) % 16;
export const opposite = (d: number) => turn(d, 8);

const clean = (v: number) => (Math.abs(v) < 1e-9 ? 0 : Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : v);

/** Unit vector for a 16-way direction (exact for the 4 cardinals). */
export const dirVec = (d: number): Vec => {
	const a = (d * Math.PI) / 8;
	return [clean(Math.sin(a)), clean(-Math.cos(a))];
};

/** Rotate a north-frame offset clockwise by direction `d`. */
export const rotate = (x: number, y: number, d: number): Vec => {
	const a = (d * Math.PI) / 8;
	const c = Math.cos(a);
	const s = Math.sin(a);
	return [clean(x * c - y * s), clean(x * s + y * c)];
};

export const isCardinal = (d: number) => d % 4 === 0;
export const isSideways = (d: number) => d === 4 || d === 12;

/** Footprint after rotation: east/west swap width and height. */
export const footprint = (w: number, h: number, d: number): Vec => (isSideways(d) ? [h, w] : [w, h]);

/** Pack a tile coordinate into a number key (valid to about ±1M tiles). */
export const tileKey = (tx: number, ty: number) => (tx + 1048576) * 2097152 + (ty + 1048576);
const cellOf = (x: number, y: number): Vec => [Math.floor(x), Math.floor(y)];

/** Append `value` to the list at `key`. */
const addTo = <V>(map: Map<number, V[]>, key: number, value: V) => {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
};

/** Minimal per-entity view the geometry functions need. */
export interface GeoEntity {
	name: string;
	kind: Kind;
	x: number;
	y: number;
	dir: number;
	/** North-facing footprint. */
	w: number;
	h: number;
	io?: 'in' | 'out';
	mirror?: boolean;
	/** Recipe uses a fluid. */
	fluid?: boolean;
	known?: boolean;
	extra?: EntityExtra;
}

export const toGeo = (page: CompactPage): GeoEntity[] =>
	page.entities.map(([n, x, y, dir, extra]) => {
		const info = page.names[n];
		return {
			name: info.name,
			kind: info.kind,
			x,
			y,
			dir,
			w: info.w,
			h: info.h,
			io: extra?.io,
			mirror: !!extra?.mirror,
			fluid: !!extra?.fluid,
			known: info.known,
			extra
		};
	});

/** Tiles an entity covers (its rotated footprint). */
export const cellsOf = (e: Pick<GeoEntity, 'x' | 'y' | 'w' | 'h' | 'dir'>): Vec[] => {
	const [w, h] = footprint(e.w, e.h, e.dir);
	const x0 = Math.round(e.x - w / 2);
	const y0 = Math.round(e.y - h / 2);
	const out: Vec[] = [];
	for (let i = 0; i < Math.max(1, w); i++) for (let j = 0; j < Math.max(1, h); j++) out.push([x0 + i, y0 + j]);
	return out;
};

// ---------------------------------------------------------------------------------------
// Belts

/** -1: curves in from the left of the flow, +1: from the right, 0: straight. */
export type BeltShape = -1 | 0 | 1;

/**
 * Cells that push items forward into the next tile, keyed by tile: belts, underground
 * exits, both halves of a splitter, and the belt end of an unloading loader.
 */
const beltEmitters = (ents: GeoEntity[]): Map<number, number> => {
	const out = new Map<number, number>();
	for (const e of ents) {
		if (!isCardinal(e.dir)) continue;
		if (e.kind === 'belt' || (e.kind === 'underground' && e.io === 'out')) {
			const [tx, ty] = cellOf(e.x, e.y);
			out.set(tileKey(tx, ty), e.dir);
		} else if (e.kind === 'splitter') {
			for (const [tx, ty] of cellsOf(e)) out.set(tileKey(tx, ty), e.dir);
		} else if (e.kind === 'loader' && e.io === 'out') {
			// The belt end is the cell furthest along the flow.
			const cells = cellsOf(e);
			const [vx, vy] = dirVec(e.dir);
			cells.sort((a, b) => b[0] * vx + b[1] * vy - (a[0] * vx + a[1] * vy));
			out.set(tileKey(cells[0][0], cells[0][1]), e.dir);
		}
	}
	return out;
};

/**
 * Belt curves, worked out the way the game does: a belt curves when nothing feeds it from
 * behind and exactly one belt-like neighbour feeds it from one side. Fed from behind, or
 * from both sides, it stays straight (side-loading).
 */
export const beltShapes = (ents: GeoEntity[]): BeltShape[] => {
	const emit = beltEmitters(ents);
	const feeds = (tx: number, ty: number, dir: number) => emit.get(tileKey(tx, ty)) === dir;
	return ents.map((e) => {
		if (e.kind !== 'belt' || !isCardinal(e.dir)) return 0;
		const [tx, ty] = cellOf(e.x, e.y);
		const d = e.dir;
		const [bx, by] = dirVec(opposite(d));
		if (feeds(tx + bx, ty + by, d)) return 0;
		const [lx, ly] = dirVec(turn(d, -4));
		const [rx, ry] = dirVec(turn(d, 4));
		// A left neighbour feeds us when it points right (d + 4), and vice versa.
		const fromLeft = feeds(tx + lx, ty + ly, turn(d, 4));
		const fromRight = feeds(tx + rx, ty + ry, turn(d, -4));
		if (fromLeft === fromRight) return 0;
		return fromLeft ? -1 : 1;
	});
};

export const undergroundMax = (name: string) => UNDERGROUND_MAX[name] ?? UNDERGROUND_MAX_DEFAULT;

/**
 * Pair underground belt entrances with exits. From each input, scan along its flow for
 * the first underground of the same name on the same axis: it pairs when that one is an
 * output facing the same way; anything else on the axis blocks the tunnel.
 * Returns partner index per entity (-1 when none).
 */
export const pairUndergrounds = (ents: GeoEntity[], maxOf: (name: string) => number = undergroundMax): Int32Array => {
	const at = new Map<number, number[]>();
	ents.forEach((e, i) => {
		if (e.kind !== 'underground') return;
		const [tx, ty] = cellOf(e.x, e.y);
		addTo(at, tileKey(tx, ty), i);
	});
	const partner = new Int32Array(ents.length).fill(-1);
	ents.forEach((e, i) => {
		if (e.kind !== 'underground' || e.io !== 'in' || !isCardinal(e.dir)) return;
		const [tx, ty] = cellOf(e.x, e.y);
		const [vx, vy] = dirVec(e.dir);
		const max = maxOf(e.name);
		for (let k = 1; k <= max; k++) {
			const hits = at.get(tileKey(tx + vx * k, ty + vy * k)) ?? [];
			const j = hits.find((h) => ents[h].name === e.name && (ents[h].dir === e.dir || ents[h].dir === opposite(e.dir)));
			if (j === undefined) continue;
			if (ents[j].io === 'out' && ents[j].dir === e.dir && partner[j] === -1) {
				partner[i] = j;
				partner[j] = i;
			}
			return;
		}
	});
	return partner;
};

// ---------------------------------------------------------------------------------------
// Inserters

/**
 * Pickup and drop points, absolute. An inserter's `direction` names its pickup side: the
 * prototypes put pickup at (0, -reach) and drop at (0, reach + 0.2) for a north-facing
 * inserter, unchanged from 0.17 to 2.0. 2.0 overrides are offsets from the centre.
 */
export const inserterHands = (e: GeoEntity): { pickup: Vec; drop: Vec } => {
	const reach = INSERTER_REACH[e.name] ?? (/long/.test(e.name) ? 2 : 1);
	const [px, py] = e.extra?.pickup ?? rotate(0, -reach, e.dir);
	const [dx, dy] = e.extra?.drop ?? rotate(0, reach, e.dir);
	return { pickup: [e.x + px, e.y + py], drop: [e.x + dx, e.y + dy] };
};

// ---------------------------------------------------------------------------------------
// Pipes and fluid boxes

export interface FluidPort {
	entity: number;
	/** Index into the entity's FluidSpec connections, or -1 for pipes. */
	conn: number;
	/** Tile the port sits on. */
	tx: number;
	ty: number;
	/** Outward world direction. */
	dir: number;
	flow: FluidConnection['flow'];
	/** Index of the port it joins, or -1. */
	joined: number;
}

export interface PipeNetwork {
	ports: FluidPort[];
	/** Per entity: bitmask of connected sides for pipes and pipes-to-ground (1 N, 2 E, 4 S, 8 W). */
	sides: Uint8Array;
	/** Per entity: pipe-to-ground partner index, or -1. */
	underground: Int32Array;
	/** Per entity: its port indices (fluid entities and pipes). */
	portsOf: number[][];
}

const SIDE_BIT: Record<number, number> = { 0: 1, 4: 2, 8: 4, 12: 8 };

/** Fluid ports of a non-pipe entity in world space, or [] when it has none (or they're off). */
export const fluidPorts = (e: GeoEntity): { tx: number; ty: number; dir: number; flow: FluidConnection['flow']; conn: number }[] => {
	const spec = FLUID_SPECS[e.name];
	if (!spec || !isCardinal(e.dir)) return [];
	if (spec.recipeGated && !e.fluid) return [];
	return spec.connections.map((c, conn) => {
		let { x, y, dir } = c;
		if (spec.positions) [x, y] = spec.positions[e.dir / 4];
		else {
			if (e.mirror) {
				x = -x;
				dir = (16 - dir) % 16;
			}
			[x, y] = rotate(x, y, e.dir);
		}
		const wd = turn(dir, e.dir);
		const [tx, ty] = cellOf(e.x + x, e.y + y);
		return { tx, ty, dir: wd, flow: c.flow, conn };
	});
};

/**
 * Join fluid ports: pipes offer all four sides, pipes-to-ground only their above-ground
 * side (`direction`), machines the connections in prototypes.ts. Two ports join when each
 * points at the other's tile. Pipes-to-ground pair underground along the facing axis.
 */
export const pipeNetwork = (ents: GeoEntity[]): PipeNetwork => {
	const ports: FluidPort[] = [];
	const portsOf: number[][] = ents.map(() => []);
	const add = (p: Omit<FluidPort, 'joined'>) => {
		portsOf[p.entity].push(ports.length);
		ports.push({ ...p, joined: -1 });
	};
	ents.forEach((e, i) => {
		const [tx, ty] = cellOf(e.x, e.y);
		if (e.kind === 'pipe') {
			for (const dir of [0, 4, 8, 12]) add({ entity: i, conn: -1, tx, ty, dir, flow: 'io' });
		} else if (e.kind === 'pipe-to-ground') {
			if (isCardinal(e.dir)) add({ entity: i, conn: -1, tx, ty, dir: e.dir, flow: 'io' });
		} else {
			for (const p of fluidPorts(e)) add({ entity: i, ...p });
		}
	});
	const byTile = new Map<number, number[]>();
	ports.forEach((p, i) => addTo(byTile, tileKey(p.tx, p.ty), i));
	ports.forEach((p, i) => {
		if (p.joined !== -1) return;
		const [vx, vy] = dirVec(p.dir);
		const back = opposite(p.dir);
		const j = (byTile.get(tileKey(p.tx + vx, p.ty + vy)) ?? []).find(
			(q) => ports[q].dir === back && ports[q].entity !== p.entity && ports[q].joined === -1
		);
		if (j === undefined) return;
		p.joined = j;
		ports[j].joined = i;
	});

	const sides = new Uint8Array(ents.length);
	ports.forEach((p) => {
		if (p.joined === -1) return;
		const k = ents[p.entity].kind;
		if (k === 'pipe' || k === 'pipe-to-ground') sides[p.entity] |= SIDE_BIT[p.dir] ?? 0;
	});

	// Pipe-to-ground pairs: the underground side is opposite `direction`.
	const ptgAt = new Map<number, number[]>();
	ents.forEach((e, i) => {
		if (e.kind !== 'pipe-to-ground') return;
		const [tx, ty] = cellOf(e.x, e.y);
		addTo(ptgAt, tileKey(tx, ty), i);
	});
	const underground = new Int32Array(ents.length).fill(-1);
	ents.forEach((e, i) => {
		if (e.kind !== 'pipe-to-ground' || underground[i] !== -1 || !isCardinal(e.dir)) return;
		const down = opposite(e.dir);
		const [tx, ty] = cellOf(e.x, e.y);
		const [vx, vy] = dirVec(down);
		for (let k = 1; k <= PIPE_TO_GROUND_MAX; k++) {
			const hits = ptgAt.get(tileKey(tx + vx * k, ty + vy * k)) ?? [];
			const j = hits.find((h) => ents[h].name === e.name && (ents[h].dir === e.dir || ents[h].dir === down));
			if (j === undefined) continue;
			if (ents[j].dir === down && underground[j] === -1) {
				underground[i] = j;
				underground[j] = i;
			}
			return;
		}
	});
	return { ports, sides, underground, portsOf };
};

// ---------------------------------------------------------------------------------------
// Unknown (modded) entity sizes

/**
 * Guess a footprint for names the game data doesn't know. Position parity gives odd or
 * even sides; grow by 2 while the square stays clear of every other entity, up to 9.
 */
export const guessUnknownSizes = (ents: GeoEntity[]): void => {
	const taken = new Map<number, number>();
	ents.forEach((e, i) => {
		const cells = e.known === false ? [cellOf(e.x, e.y)] : cellsOf(e);
		for (const [tx, ty] of cells) taken.set(tileKey(tx, ty), i);
	});
	ents.forEach((e, i) => {
		if (e.known !== false || e.kind !== 'box') return;
		const odd = (v: number) => Math.abs(v - Math.floor(v) - 0.5) < 0.01;
		let w = odd(e.x) ? 1 : 2;
		let h = odd(e.y) ? 1 : 2;
		const free = (ww: number, hh: number) => {
			const x0 = Math.round(e.x - ww / 2);
			const y0 = Math.round(e.y - hh / 2);
			for (let a = 0; a < ww; a++)
				for (let b = 0; b < hh; b++) {
					const o = taken.get(tileKey(x0 + a, y0 + b));
					if (o !== undefined && o !== i) return false;
				}
			return true;
		};
		if (!free(w, h)) [w, h] = [1, 1];
		while (w + 2 <= 9 && h + 2 <= 9 && free(w + 2, h + 2)) {
			w += 2;
			h += 2;
		}
		e.w = w;
		e.h = h;
		// The guess is already in world orientation.
		if (isSideways(e.dir)) [e.w, e.h] = [h, w];
	});
};
