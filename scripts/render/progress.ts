/**
 * Pages/s and the ETA for the run row. Pages are very skewed in size, so the ETA counts work units
 * (a page's entities plus a fixed overhead) rather than pages: units done per second over the last
 * few minutes, against the units still queued and half of those in flight (on average half done).
 */

/** Pages/s is measured over this window. */
export const RATE_WINDOW_MS = 5 * 60_000;

/** Work for the ETA: a page costs its entities plus a fixed overhead. */
export const workUnits = (w: { entities: number }) => w.entities + 500;

export function renderProgress(windowMs = RATE_WINDOW_MS) {
	/** Rendered and failed pages: when, and their work units. */
	const completions: { t: number; units: number }[] = [];
	let inFlightUnits = 0;
	let startedAt = 0;
	return {
		/** Rendering began (the rate counts from then). */
		start(t = Date.now()) {
			startedAt = t;
		},
		get started() {
			return startedAt > 0;
		},
		/** A page went to a worker, or came back from one. */
		began(w: { entities: number }) {
			inFlightUnits += workUnits(w);
		},
		ended(w: { entities: number }) {
			inFlightUnits -= workUnits(w);
		},
		/** A page reached a final state (rendered or failed for good). */
		completed(w: { entities: number }, t = Date.now()) {
			completions.push({ t, units: workUnits(w) });
		},
		/** Pages/s (3 decimals) and seconds left for the pages in `todo` and in flight; nulls before anything completed. */
		rateAndEta(todo: readonly { entities: number }[], t = Date.now()): { rate: number | null; eta: number | null } {
			while (completions.length && completions[0].t < t - windowMs) completions.shift();
			if (!startedAt || !completions.length) return { rate: null, eta: null };
			const span = Math.max(1, Math.min(windowMs, t - startedAt) / 1000);
			const rate = completions.length / span;
			const unitRate = completions.reduce((n, c) => n + c.units, 0) / span;
			const left = todo.reduce((n, w) => n + workUnits(w), 0) + inFlightUnits / 2;
			return { rate: Math.round(rate * 1000) / 1000, eta: Math.round(left / unitRate) };
		}
	};
}

export type RenderProgress = ReturnType<typeof renderProgress>;
