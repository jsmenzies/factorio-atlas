import { describe, expect, test } from 'bun:test';
import { pageBase, pickLevel, RENDER_FILE, tileFile, tileRect, visibleTiles, type RenderLevel } from './game-render.js';

// Big Boy's shape: 260×132 tiles, overview at 7 px/tile, three tile levels.
const frame = { minX: -130, minY: -92, maxX: 130, maxY: 40 };
const level = (ppt: number): RenderLevel => {
	const width = 260 * ppt;
	const height = 132 * ppt;
	return { ppt, width, height, cols: Math.ceil(width / 512), rows: Math.ceil(height / 512) };
};
const sc = { path: '', frame, tile: 512, overview: { width: 1820, height: 924, ppt: 7 }, levels: [level(16), level(32), level(64)] };

describe('game render', () => {
	test('picks the coarsest level sharp enough for the zoom', () => {
		expect(pickLevel(sc, 5)).toBe(null);
		expect(pickLevel(sc, 12)!.ppt).toBe(16);
		expect(pickLevel(sc, 30)!.ppt).toBe(32);
		expect(pickLevel(sc, 50)!.ppt).toBe(64);
		expect(pickLevel(sc, 320)!.ppt).toBe(64);
		expect(pickLevel({ ...sc, levels: [] }, 320)).toBe(null);
	});

	test('tiles map back to world tiles, edge tiles are smaller', () => {
		const l = level(64);
		expect(tileRect(sc, l, 0, 0)).toEqual({ x: -130, y: -92, w: 8, h: 8 });
		// 260 tiles = 32 full tiles of 8 + one of 4.
		expect(tileRect(sc, l, 32, 16)).toEqual({ x: 126, y: 36, w: 4, h: 4 });
	});

	test('visible tiles cover the view and stay in range', () => {
		const l = level(64);
		expect(visibleTiles(sc, l, -130, -92, -121, -85)).toEqual([
			[0, 0],
			[1, 0]
		]);
		expect(visibleTiles(sc, l, -1000, -1000, 1000, 1000).length).toBe(l.cols * l.rows);
	});

	test('file names follow book paths', () => {
		expect(pageBase('')).toBe('root');
		expect(tileFile({ path: '3/1' }, 64, 2, 5)).toBe('3/1.tiles/64/2-5.webp');
		for (const ok of ['root.webp', '3/1.json', 'root.tiles/64/0-12.webp', 'index.json']) expect(RENDER_FILE.test(ok)).toBe(true);
		for (const bad of ['../x.json', 'root.png', '3/x.webp', 'root.tiles/64/a-1.webp']) expect(RENDER_FILE.test(bad)).toBe(false);
	});
});
