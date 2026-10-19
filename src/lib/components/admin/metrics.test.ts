import { describe, expect, test } from 'bun:test';
import {
	bytes,
	clock,
	validTimeZone,
	compact,
	duration,
	elapsed,
	eta,
	failureRows,
	optionChips,
	percent,
	projection,
	rateText,
	shownState,
	summary
} from './metrics.js';

const STALE = 60_000;

describe('metrics', () => {
	test('shownState infers crashed from a stale heartbeat on a live run only', () => {
		expect(shownState({ state: 'running', updated_at: 0 }, 30_000, STALE)).toBe('running');
		expect(shownState({ state: 'running', updated_at: 0 }, 61_000, STALE)).toBe('crashed');
		expect(shownState({ state: 'paused', updated_at: 0 }, 61_000, STALE)).toBe('crashed');
		expect(shownState({ state: 'finished', updated_at: 0 }, 1e9, STALE)).toBe('finished');
	});

	test('rate switches unit below one a second', () => {
		expect(rateText(12.34)).toBe('12 prints/s');
		expect(rateText(2.345)).toBe('2.3 prints/s');
		expect(rateText(0.5)).toBe('30 prints/min');
		expect(rateText(0.01)).toBe('36 prints/h');
		expect(rateText(null)).toBe(null);
		expect(rateText(0)).toBe(null);
	});

	test('durations, bytes, percentages', () => {
		expect(duration(45_000)).toBe('45 s');
		expect(duration(125_000)).toBe('2 min 5 s');
		expect(duration(4_000_000)).toBe('1 h 6 min');
		expect(duration(200_000_000)).toBe('2 d 7 h');
		expect(bytes(512)).toBe('512 B');
		expect(bytes(1536)).toBe('1.5 KB');
		expect(bytes(1.2 * 1024 ** 3)).toBe('1.2 GB');
		expect(percent(1, 3)).toBe('33%');
		expect(percent(1, 2000)).toBe('<0.1%');
		expect(percent(5, 0)).toBe('0%');
		expect(compact(420_000)).toBe('420k');
		expect(compact(4_200_000)).toBe('4.2M');
	});

	test('projection scales the mix so far to the total', () => {
		const p = projection({ done: 100, total: 18_000, rows_written: 2300, r2_objects: 1700, r2_bytes: 5_000_000 });
		expect(p?.rowsPerPrint).toBe(23);
		expect(p?.rows).toBe(414_000);
		expect(p?.objects).toBe(306_000);
		expect(projection({ done: 0, total: 10, rows_written: 0, r2_objects: 0, r2_bytes: 0 })).toBe(null);
	});

	test('eta counts from the heartbeat', () => {
		expect(eta({ eta_seconds: 60, updated_at: 1000 }, 31_000)).toEqual({ left: 30_000, at: 61_000 });
		expect(eta({ eta_seconds: null, updated_at: 0 }, 0)).toBe(null);
	});

	test('elapsed stops at the last heartbeat once crashed', () => {
		const run = { started_at: 0, updated_at: 10_000, finished_at: null };
		expect(elapsed(run, 'running', 20_000)).toBe(20_000);
		expect(elapsed(run, 'crashed', 500_000)).toBe(10_000);
		expect(elapsed({ ...run, finished_at: 15_000 }, 'finished', 500_000)).toBe(15_000);
	});

	test('clock says tomorrow across midnight', () => {
		const now = new Date(2026, 9, 19, 23, 0).getTime();
		expect(clock(new Date(2026, 9, 19, 23, 30).getTime(), now)).toBe('23:30');
		expect(clock(new Date(2026, 9, 20, 2, 10).getTime(), now)).toBe('tomorrow 02:10');
	});

	test('clock uses the given time zone', () => {
		const at = Date.UTC(2026, 9, 19, 23, 30);
		expect(clock(at, at, 'UTC')).toBe('23:30');
		expect(clock(at, at, 'Australia/Sydney')).toBe('10:30');
		expect(clock(at, Date.UTC(2026, 9, 19, 12), 'Australia/Sydney')).toBe('tomorrow 10:30');
		expect(validTimeZone('Europe/London')).toBe('Europe/London');
		expect(validTimeZone('Not/AZone')).toBe(null);
		expect(validTimeZone(undefined)).toBe(null);
	});

	test('summary, chips and failure rows', () => {
		const run = {
			done: 1204,
			total: 1500,
			analysed: 1100,
			viewer: 0,
			reindexed: 0,
			favorites: 0,
			unchanged: 80,
			failed: 24,
			skipped_failed: 0
		};
		expect(summary(run)).toBe('1,204 of 1,500 done: 1,100 analysed, 80 unchanged and 24 failed.');
		expect(optionChips({ concurrency: 4, limit: 500, force: false, retryFailed: true })).toEqual([
			'4 workers',
			'limit 500',
			'retry failed'
		]);
		expect(failureRows({ timeout: 5, decode: 41, x: 0 })).toEqual([
			['decode', 41],
			['timeout', 5]
		]);
	});
});
