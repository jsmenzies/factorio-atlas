import { describe, expect, test } from 'bun:test';
import { alignToGrid } from './extract.js';
import { beltShapes, inserterHands, normalizeDirection, pairUndergrounds, pipeNetwork, railLine, type GeoEntity } from './geometry.js';
import type { CompactEntity, NameInfo } from './types.js';

const N = 0,
	E = 4,
	S = 8,
	W = 12;

const ent = (kind: GeoEntity['kind'], x: number, y: number, dir: number, more: Partial<GeoEntity> = {}): GeoEntity => ({
	name: kind === 'underground' ? 'underground-belt' : kind === 'belt' ? 'transport-belt' : kind,
	kind,
	x,
	y,
	dir,
	w: 1,
	h: 1,
	known: true,
	...more
});
const belt = (x: number, y: number, dir: number) => ent('belt', x + 0.5, y + 0.5, dir);

describe('direction normalisation', () => {
	test('1.x uses 8 directions: east = 2, south = 4, west = 6', () => {
		expect([0, 2, 4, 6].map((d) => normalizeDirection(d, 1))).toEqual([N, E, S, W]);
		expect(normalizeDirection(1, 0)).toBe(2); // NE in 0.17
		expect(normalizeDirection(7, 1)).toBe(14); // NW
	});
	test('2.0 uses 16 directions: east = 4, south = 8, west = 12', () => {
		expect([0, 4, 8, 12].map((d) => normalizeDirection(d, 2))).toEqual([N, E, S, W]);
		expect(normalizeDirection(2, 2)).toBe(2);
	});
	test('missing direction is north', () => {
		expect(normalizeDirection(undefined, 1)).toBe(N);
		expect(normalizeDirection(undefined, 2)).toBe(N);
	});
});

describe('belt curves', () => {
	test('a belt fed only from one side curves', () => {
		// → then ↑ : the north-facing belt at (1,0) is fed from its left (west).
		const ents = [belt(0, 0, E), belt(1, 0, N)];
		expect(beltShapes(ents)).toEqual([0, -1]);
	});
	test('fed from the right side curves the other way', () => {
		const ents = [belt(2, 0, W), belt(1, 0, N)];
		expect(beltShapes(ents)).toEqual([0, 1]);
	});
	test('fed from behind stays straight, even with side-loading', () => {
		const ents = [belt(1, 1, N), belt(0, 0, E), belt(1, 0, N)];
		expect(beltShapes(ents)[2]).toBe(0);
	});
	test('fed from both sides stays straight', () => {
		const ents = [belt(0, 0, E), belt(2, 0, W), belt(1, 0, N)];
		expect(beltShapes(ents)[2]).toBe(0);
	});
	test('a neighbour pointing elsewhere does not count', () => {
		const ents = [belt(0, 0, S), belt(1, 0, N)];
		expect(beltShapes(ents)[1]).toBe(0);
	});
	test('underground exits and splitters feed curves; entrances do not', () => {
		const exit = ent('underground', 0.5, 0.5, E, { io: 'out' });
		expect(beltShapes([exit, belt(1, 0, S)])[1]).toBe(1);
		const entrance = ent('underground', 0.5, 0.5, E, { io: 'in' });
		expect(beltShapes([entrance, belt(1, 0, S)])[1]).toBe(0);
		// Splitter facing east at x=0 covers (0,0) and (0,1); the belt at (1,1) turns south.
		const splitter = ent('splitter', 0.5, 1, E, { name: 'splitter', w: 2, h: 1 });
		expect(beltShapes([splitter, belt(1, 1, S)])[1]).toBe(1);
	});
	test('the corner direction follows rotation for every flow direction', () => {
		for (const d of [N, E, S, W]) {
			// Feed from the left of flow d: neighbour at left points right.
			const left = (d + 12) % 16;
			const v = { 0: [0, -1], 4: [1, 0], 8: [0, 1], 12: [-1, 0] }[left]!;
			const ents = [belt(5 + v[0], 5 + v[1], (d + 4) % 16), belt(5, 5, d)];
			expect(beltShapes(ents)[1]).toBe(-1);
		}
	});
});

describe('underground pairing', () => {
	const ug = (x: number, y: number, dir: number, io: 'in' | 'out', name = 'underground-belt') =>
		ent('underground', x + 0.5, y + 0.5, dir, { io, name });
	test('pairs an entrance with the next exit facing the same way', () => {
		expect([...pairUndergrounds([ug(0, 0, E, 'in'), ug(4, 0, E, 'out')])]).toEqual([1, 0]);
	});
	test('respects max distance (5 basic, 9 express)', () => {
		expect([...pairUndergrounds([ug(0, 0, E, 'in'), ug(6, 0, E, 'out')])]).toEqual([-1, -1]);
		const ex = 'express-underground-belt';
		expect([...pairUndergrounds([ug(0, 0, S, 'in', ex), ug(0, 9, S, 'out', ex)])]).toEqual([1, 0]);
	});
	test('needs the same tier', () => {
		expect([...pairUndergrounds([ug(0, 0, E, 'in'), ug(2, 0, E, 'out', 'fast-underground-belt')])]).toEqual([-1, -1]);
	});
	test('pairs with the nearest exit; a same-tier piece in between blocks', () => {
		const ents = [ug(0, 0, E, 'in'), ug(2, 0, E, 'out'), ug(4, 0, E, 'out')];
		expect([...pairUndergrounds(ents)]).toEqual([1, 0, -1]);
		const blocked = [ug(0, 0, E, 'in'), ug(2, 0, W, 'out'), ug(4, 0, E, 'out')];
		expect(pairUndergrounds(blocked)[0]).toBe(-1);
	});
	test('perpendicular undergrounds do not interfere (weaving)', () => {
		const ents = [ug(0, 0, E, 'in'), ug(2, 0, N, 'in'), ug(4, 0, E, 'out')];
		expect(pairUndergrounds(ents)[0]).toBe(2);
	});
	test('works with 1.x directions after normalisation', () => {
		const d = normalizeDirection(6, 1); // west
		expect([...pairUndergrounds([ug(5, 0, d, 'in'), ug(1, 0, d, 'out')])]).toEqual([1, 0]);
	});
});

describe('inserters', () => {
	test('direction names the pickup side; drop is opposite', () => {
		const i = ent('inserter', 0.5, 0.5, N, { name: 'inserter' });
		const { pickup, drop } = inserterHands(i);
		expect(pickup).toEqual([0.5, -0.5]);
		expect(drop).toEqual([0.5, 1.5]);
	});
	test('long-handed reaches 2 tiles, rotated', () => {
		const i = ent('inserter', 0.5, 0.5, E, { name: 'long-handed-inserter' });
		const { pickup, drop } = inserterHands(i);
		expect(pickup).toEqual([2.5, 0.5]);
		expect(drop).toEqual([-1.5, 0.5]);
	});
	test('2.0 pickup/drop overrides win', () => {
		const i = ent('inserter', 0.5, 0.5, N, { name: 'inserter', extra: { pickup: [1, 0], drop: [-1, 0] } });
		expect(inserterHands(i)).toEqual({ pickup: [1.5, 0.5], drop: [-0.5, 0.5] });
	});
});

describe('pipes', () => {
	test('pipes join neighbours; pipe-to-ground pairs along its axis', () => {
		const ents: GeoEntity[] = [
			ent('pipe', 0.5, 0.5, N),
			ent('pipe', 1.5, 0.5, N),
			// Opens west (toward the pipe), goes underground east.
			ent('pipe-to-ground', 2.5, 0.5, W, { name: 'pipe-to-ground' }),
			ent('pipe-to-ground', 8.5, 0.5, E, { name: 'pipe-to-ground' })
		];
		const net = pipeNetwork(ents);
		expect(net.sides[0]).toBe(2); // east only
		expect(net.sides[1]).toBe(2 | 8);
		expect(net.sides[2]).toBe(8);
		expect(net.underground[2]).toBe(3);
	});
	test('fluid machines expose rotated ports', () => {
		// Chemical plant facing south: both inputs end up on the south corners, outputs north.
		const plant = ent('box', 1.5, 1.5, S, { name: 'chemical-plant', w: 3, h: 3 });
		const below = [0.5, 1.5, 2.5].map((x) => ent('pipe', x, 3.5, N));
		const above = ent('pipe', 0.5, -0.5, N);
		const net = pipeNetwork([plant, ...below, above]);
		expect([net.sides[1] & 1, net.sides[2] & 1, net.sides[3] & 1]).toEqual([1, 0, 1]);
		expect(net.sides[4] & 4).toBe(4);
		const flows = net.portsOf[0].map((p) => [net.ports[p].flow, net.ports[p].dir]);
		expect(flows).toEqual([
			['in', S],
			['in', S],
			['out', N],
			['out', N]
		]);
	});
});

describe('pre-1.0 half-tile offset', () => {
	test('shifts integer-positioned 1×1 entities onto tile centres', () => {
		const names: NameInfo[] = [
			{ name: 'transport-belt', proto: 'transport-belt', type: 'transport-belt', category: 'belts', kind: 'belt', w: 1, h: 1, known: true }
		];
		const rows: CompactEntity[] = [
			[0, 0, 0, 0],
			[0, 1, 0, 0]
		];
		expect(alignToGrid(rows, names)).toEqual([0.5, 0.5]);
		expect(rows[0][1]).toBe(0.5);
		expect(rows[0][2]).toBe(0.5);
	});
});

describe('rails', () => {
	test('draw as lines, not boxes', () => {
		const line = railLine({ kind: 'rail-straight', x: 1, y: 1, dir: E })!;
		expect(line).toEqual([
			[2, 1],
			[0, 1]
		]);
		expect(railLine({ kind: 'rail-curve-a', x: 0, y: 0, dir: 3 })!.length).toBeGreaterThan(5);
		expect(railLine({ kind: 'box', x: 0, y: 0, dir: 0 })).toBe(null);
	});
});
