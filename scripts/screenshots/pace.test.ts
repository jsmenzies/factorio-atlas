import { describe, expect, test } from 'bun:test';
import { backoffMs, pacer, pool, type Clock } from './pace.js';

/** A clock that only moves when something sleeps. */
const fakeClock = () => {
	let t = 1_000_000;
	const clock: Clock = {
		now: () => t,
		sleep: async (ms) => {
			t += ms;
		}
	};
	return { clock, time: () => t };
};

describe('pacer', () => {
	test('starts at most `rate` a second, the first at once', async () => {
		const { clock, time } = fakeClock();
		const p = pacer(4, clock);
		const starts: number[] = [];
		for (let i = 0; i < 5; i++) {
			await p.take();
			starts.push(time());
		}
		expect(starts.map((s) => s - starts[0])).toEqual([0, 250, 500, 750, 1000]);
	});

	test('callers waiting at once get slots 250 ms apart', async () => {
		let t = 0;
		const waits: number[] = [];
		const p = pacer(4, { now: () => t, sleep: async (ms) => void waits.push(ms) });
		await Promise.all([p.take(), p.take(), p.take(), p.take()]);
		expect(waits).toEqual([250, 500, 750]);
		t = 5000; // idle for a while: no burst credit is saved up beyond the next slot
		await p.take();
		expect(waits.length).toBe(3);
	});
});

test('backoffMs', () => {
	expect(backoffMs(1, () => 0.5)).toBe(2000);
	expect(backoffMs(2, () => 0.5)).toBe(8000);
	expect(backoffMs(1, () => 0)).toBe(1500);
	expect(backoffMs(1, () => 1)).toBe(2500);
});

describe('pool', () => {
	test('at most n at once, every item once, in order', async () => {
		let live = 0;
		let peak = 0;
		const seen: number[] = [];
		await pool(
			Array.from({ length: 10 }, (_, i) => i),
			4,
			async (i) => {
				live++;
				peak = Math.max(peak, live);
				seen.push(i);
				await new Promise((r) => setTimeout(r, 1));
				live--;
			},
			() => false
		);
		expect(peak).toBe(4);
		expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	test('no new item once stopped', async () => {
		const seen: number[] = [];
		let stop = false;
		await pool(
			[1, 2, 3, 4, 5],
			1,
			async (i) => {
				seen.push(i);
				if (i === 2) stop = true;
			},
			() => stop
		);
		expect(seen).toEqual([1, 2]);
	});
});
