import { describe, expect, test } from 'bun:test';
import { renderProgress, workUnits } from './progress.js';

/** A clock time to start from (0 would read as not started). */
const T = 1_000_000;

describe('renderProgress', () => {
	test('nothing before rendering starts or a page completes', () => {
		const p = renderProgress();
		expect(p.started).toBe(false);
		p.completed({ entities: 0 }, T + 1000);
		expect(p.rateAndEta([], T + 2000)).toEqual({ rate: null, eta: null });
		p.start(T);
		expect(p.started).toBe(true);
		expect(renderProgress().rateAndEta([], T)).toEqual({ rate: null, eta: null });
	});

	test('pages/s since the start, and the ETA in work units, pages in flight counting half', () => {
		const p = renderProgress(60_000);
		p.start(T);
		// 2 pages of 500 units in 10 s: 0.2 pages/s, 100 units/s.
		p.completed({ entities: 0 }, T + 4_000);
		p.completed({ entities: 0 }, T + 9_000);
		p.began({ entities: 1500 });
		const todo = [{ entities: 500 }];
		// 1000 queued + 2000 / 2 in flight = 2000 units at 100/s.
		expect(p.rateAndEta(todo, T + 10_000)).toEqual({ rate: 0.2, eta: 20 });
		p.ended({ entities: 1500 });
		expect(p.rateAndEta(todo, T + 10_000).eta).toBe(10);
	});

	test('only the window counts', () => {
		const p = renderProgress(60_000);
		p.start(T);
		p.completed({ entities: 0 }, T + 1_000);
		p.completed({ entities: 0 }, T + 100_000);
		expect(p.rateAndEta([], T + 120_000)).toEqual({ rate: Math.round((1 / 60) * 1000) / 1000, eta: 0 });
		expect(p.rateAndEta([], T + 200_000)).toEqual({ rate: null, eta: null });
	});

	test('a page costs its entities plus a fixed overhead', () => {
		expect(workUnits({ entities: 0 })).toBe(500);
		expect(workUnits({ entities: 1234 })).toBe(1734);
	});
});
