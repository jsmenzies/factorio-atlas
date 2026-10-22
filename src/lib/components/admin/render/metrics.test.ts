import { describe, expect, test } from 'bun:test';
import {
	byteRate,
	fileRate,
	ms,
	pageName,
	pageRate,
	perMinute,
	printHref,
	printProgress,
	renderOptionChips,
	storageProjection,
	thumbUrl,
	uploadSpeed,
	viewerHref,
	writtenAverages
} from './metrics.js';

describe('render metrics', () => {
	test('page rate switches unit below one a second', () => {
		expect(pageRate(2.345)).toBe('2.3 pages/s');
		expect(pageRate(0.42)).toBe('25 pages/min');
		expect(pageRate(null)).toBe(null);
	});

	test('storage projection: bytes per rendered page × pages left, scaled by the rendered share', () => {
		const p = storageProjection({ total: 200, done: 100, rendered: 50, files: 500, bytes: 50_000_000 });
		expect(p?.perPage).toBe(1_000_000);
		expect(p?.filesPerPage).toBe(10);
		expect(p?.upTo).toBe(100_000_000);
		expect(p?.likely).toBe(50_000_000);
		expect(storageProjection({ total: 10, done: 3, rendered: 0, files: 0, bytes: 0 })).toBe(null);
	});

	test('links to a page and its overview', () => {
		const lone = { print_id: '-Abc', path: '', overview: 'root.0123456789.avif' };
		const book = { print_id: '-Abc', path: '3/1', overview: '3/1.abcdef0123.avif' };
		expect(thumbUrl(lone)).toBe('/prints/-Abc/render/root.0123456789.avif');
		expect(thumbUrl(book)).toBe('/prints/-Abc/render/3/1.abcdef0123.avif');
		expect(thumbUrl({ ...book, overview: null })).toBe(null);
		expect(viewerHref(lone)).toBe('/prints/-Abc/render');
		expect(viewerHref(book)).toBe('/prints/-Abc/render?page=3/1');
		expect(printHref(book)).toBe('/prints/-Abc?page=3/1');
	});

	test('page names, times and option chips', () => {
		expect(pageName({ path: '', label: null })).toBe('Blueprint');
		expect(pageName({ path: '2', label: '[item=iron-plate] Smelting' })).toBe('Page 2 · Iron plate Smelting');
		expect(ms(850)).toBe('850 ms');
		expect(ms(12_340)).toBe('12.3 s');
		expect(
			renderOptionChips({
				assets: { version: '2.0.77' },
				quality: 65,
				effort: 1,
				levels: [16, 32, 64],
				workers: 8,
				force: true
			})
		).toEqual(['assets 2.0.77', 'q65', 'effort 1', '16/32/64 px/tile', '8 workers', 'force']);
		expect(renderOptionChips({ assets: '2.0.77/0123456789ab' })).toEqual(['assets 2.0.77/0123456789ab']);
	});

	test('prints progress: a batch counts what it picked, older rows have none', () => {
		expect(
			printProgress({ prints_total: 100, prints_done: 10, options: { next: 100, batch: { next: 100, picked: [], complete: true } } })
		).toEqual({ done: 10, total: 100, picking: false, goal: null, pct: 10 });
		expect(
			printProgress({ prints_total: 7, prints_done: 0, options: { batch: { next: 100, picked: [], complete: false } } })
		).toMatchObject({
			total: 7,
			picking: true,
			goal: 100
		});
		expect(printProgress({ options: {} })).toBe(null);
		expect(printProgress({ prints_total: 0, prints_done: 0, options: {} })).toBe(null);
	});

	test('written averages per page and per print', () => {
		expect(writtenAverages({ bytes: 30_000_000, files: 300, rendered: 30, prints_rendered: 10 })).toEqual({
			perPage: 1_000_000,
			filesPerPage: 10,
			perPrint: 3_000_000,
			prints: 10
		});
		expect(writtenAverages({ bytes: 0, files: 0, rendered: 0 })).toMatchObject({ perPage: null, perPrint: null });
	});

	const up = {
		upload_target: 'prod',
		upload_bytes: 600_000_000,
		upload_files: 12_000,
		uploaded: 300,
		uploads_pending: 120,
		rate: 0.5,
		total: 1000,
		done: 400,
		upload_rate_bytes: 4_000_000,
		upload_rate_files: 90,
		upload_rate_pages: 0.3
	};

	test('upload speed: falling behind while rendering outpaces it, draining after', () => {
		const behind = uploadSpeed(up, 600_000, true)!;
		expect(behind.pace).toBe('behind');
		expect(behind.etaMs).toBe(null);
		expect(behind.avgBytesPerSec).toBe(1_000_000);
		expect(behind.avgFilesPerSec).toBe(20);
		expect(uploadSpeed({ ...up, rate: 0.3 }, 600_000, true)!.pace).toBe('keeping-up');
		const keeping = uploadSpeed({ ...up, rate: 0.2 }, 600_000, true)!;
		expect(keeping.etaMs).toBeCloseTo(1_200_000);
		const draining = uploadSpeed({ ...up, done: 1000 }, 600_000, true)!;
		expect(draining.pace).toBe('draining');
		expect(draining.etaMs).toBeCloseTo(400_000);
		expect(uploadSpeed({ ...up, uploads_pending: 0 }, 600_000, true)!.pace).toBe('idle');
		expect(uploadSpeed({ ...up, upload_rate_pages: null }, 600_000, true)!.pace).toBe('stalled');
		const ended = uploadSpeed(up, 600_000, false)!;
		expect(ended.pace).toBe(null);
		expect(ended.bytesPerSec).toBe(null);
		expect(uploadSpeed({ ...up, upload_target: null }, 1, true)).toBe(null);
		const { upload_rate_bytes: _b, upload_rate_files: _f, upload_rate_pages: _p, ...before0013 } = up;
		expect(uploadSpeed(before0013, 600_000, true)).toMatchObject({ measured: false, pace: null, etaMs: null, avgBytesPerSec: 1_000_000 });
	});

	test('rate texts', () => {
		expect(byteRate(3_984_588)).toBe('3.8 MB/s');
		expect(fileRate(88.6)).toBe('89 files/s');
		expect(fileRate(0.42)).toBe('0.4 files/s');
		expect(perMinute(0.2)).toBe('12/min');
		expect(perMinute(null)).toBe('–');
	});
});
