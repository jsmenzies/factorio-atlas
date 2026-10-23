/**
 * Request pacing and the worker pool: requests start at least 1/rate apart, however many are in
 * flight, and at most `inFlight` run at once. Pure apart from the injected clock, for tests.
 */

export interface Clock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** `take()` resolves when the next request may start; slots are handed out in call order. */
export function pacer(perSecond: number, clock: Clock = realClock) {
	const gap = 1000 / perSecond;
	let next = 0;
	return {
		async take() {
			const now = clock.now();
			const at = Math.max(now, next);
			next = at + gap;
			if (at > now) await clock.sleep(at - now);
		}
	};
}

/** Wait before retry `attempt` (1-based): 2 s, 8 s, 32 s … with ±25% jitter. */
export const backoffMs = (attempt: number, random: () => number = Math.random) => 2000 * 4 ** (attempt - 1) * (0.75 + random() / 2);

/**
 * Run `work` over `items` with at most `n` at once, in order; no new item starts once `stopped()`
 * is true (items already started finish).
 */
export async function pool<T>(items: readonly T[], n: number, work: (item: T) => Promise<void>, stopped: () => boolean) {
	let i = 0;
	const lane = async () => {
		while (!stopped() && i < items.length) await work(items[i++]);
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, lane));
}
