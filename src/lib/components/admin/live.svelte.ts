import { invalidate } from '$app/navigation';

/** The `depends()` key of the pipeline pages' loads. */
export const PIPELINE_DEP = 'admin:pipeline';

/**
 * Re-runs the page's load every `interval()` ms while it returns a number, skipping while the tab
 * is hidden (and refreshing as soon as it's visible again). Null stops polling. No overlap: a
 * slow load isn't stacked on.
 */
export const poll = (interval: () => number | null) => {
	$effect(() => {
		const ms = interval();
		if (!ms) return;
		let busy = false;
		const tick = async () => {
			if (busy || document.hidden) return;
			busy = true;
			try {
				await invalidate(PIPELINE_DEP);
			} finally {
				busy = false;
			}
		};
		const timer = setInterval(tick, ms);
		const onVisible = () => {
			if (!document.hidden) void tick();
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});
};

/**
 * A clock that ticks every second, on the server's time (`offset` = server − browser), so ages
 * and staleness don't depend on the browser's clock being right.
 */
export const serverClock = (offset: () => number) => {
	let local = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (local = Date.now()), 1000);
		return () => clearInterval(timer);
	});
	return {
		get now() {
			return local + offset();
		}
	};
};

/**
 * Times are formatted in the viewer's zone, which the server learns from a `tz` cookie (Workers
 * run in UTC). On the first visit, or after travelling, set it and reload the data once.
 */
export const syncTimeZone = (current: () => string) => {
	$effect(() => {
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (!tz || tz === current()) return;
		const secure = location.protocol === 'https:' ? '; secure' : '';
		document.cookie = `tz=${encodeURIComponent(tz)}; path=/admin; max-age=31536000; samesite=lax${secure}`;
		void invalidate(PIPELINE_DEP);
	});
};
