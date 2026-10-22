import { describe, expect, test } from 'bun:test';
import {
	levelsAbove,
	overviewFile,
	pageBase,
	pickLevel,
	RENDER_FILE,
	renderCacheControl,
	sidecarFile,
	tileFile,
	tileRect,
	visibleTiles,
	type RenderLevel
} from './game-render.js';

// Big Boy's shape: 260×132 tiles, overview at 7 px/tile, three tile levels.
const frame = { minX: -130, minY: -92, maxX: 130, maxY: 40 };
const level = (ppt: number): RenderLevel => {
	const width = 260 * ppt;
	const height = 132 * ppt;
	const cols = Math.ceil(width / 512);
	const rows = Math.ceil(height / 512);
	return {
		ppt,
		width,
		height,
		cols,
		rows,
		tiles: Array.from({ length: cols * rows }, (_, i) => (i % 3 ? i.toString(16).padStart(16, '0') : ''))
	};
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

	test('every level sharper than the overview is made', () => {
		expect(levelsAbove(7, [16, 32, 64])).toEqual([16, 32, 64]);
		// A medium page (overview at 22–31 px/tile) still gets 32 px, unlike the old `ppt × 1.5` rule.
		expect(levelsAbove(25, [16, 32, 64])).toEqual([32, 64]);
		expect(levelsAbove(32, [16, 32, 64])).toEqual([64]);
		expect(levelsAbove(64, [16, 32, 64])).toEqual([]);
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

	test('tile files come from the tile map; transparent tiles have none', () => {
		const l = level(64);
		expect(tileFile(l, 0, 0)).toBe(null);
		expect(tileFile(l, 1, 0)).toBe('t/0000000000000001.avif');
		// Row-major: (col 2, row 1) is index cols + 2.
		expect(tileFile(l, 2, 1)).toBe(`t/${(l.cols + 2).toString(16).padStart(16, '0')}.avif`);
		expect(tileFile(l, l.cols, 0)).toBe(null);
		expect(tileFile(l, -1, 0)).toBe(null);
	});

	test('file names follow book paths', () => {
		expect(pageBase('')).toBe('root');
		expect(overviewFile('3/1', '0123456789')).toBe('3/1.0123456789.avif');
		expect(sidecarFile('')).toBe('root.json');
		for (const ok of [
			'root.0123456789.avif',
			'3/1.json',
			'root.page.json',
			'3/1.page.json',
			'12.abcdef0123.avif',
			't/0123456789abcdef.avif',
			'index.json'
		])
			expect(RENDER_FILE.test(ok)).toBe(true);
		for (const bad of [
			'root.avif',
			'root.0123.avif',
			'root.ABCDEF0123.avif',
			'../x.json',
			'root.png',
			'root.webp',
			'root.tiles.json',
			'index.page.json',
			'3/x.avif',
			't/0123.avif',
			't/0123456789ABCDEF.avif',
			't/../index.json',
			'x/index.json'
		])
			expect(RENDER_FILE.test(bad)).toBe(false);
	});

	test('cache rules: images for good, index a minute, the rest five minutes', () => {
		expect(renderCacheControl('t/0123456789abcdef.avif')).toBe('public, max-age=31536000, immutable');
		expect(renderCacheControl('3/1.0123456789.avif')).toBe('public, max-age=31536000, immutable');
		expect(renderCacheControl('index.json')).toBe('public, max-age=60');
		expect(renderCacheControl('3/1.json')).toBe('public, max-age=300');
		expect(renderCacheControl('root.page.json')).toBe('public, max-age=300');
	});
});
