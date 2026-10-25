import type { RateUnit } from './format.js';

/** Where the visitor's choice is kept. app.html reads it before the page draws, so keep the two in step. */
export const RATE_KEY = 'atlas.rate';

/**
 * The visitor's rate unit, for text CSS can't switch (tooltips). Pages are cached and shared, so
 * the server always renders 's'; the root layout reads the real choice from `<html data-rate>`
 * once hydrated. Visible rates use Rate.svelte, which needs none of this.
 */
export const rateUnit = $state<{ unit: RateUnit }>({ unit: 's' });

export const readRateUnit = () => {
	rateUnit.unit = document.documentElement.dataset.rate === 'min' ? 'min' : 's';
};

export const setRateUnit = (unit: RateUnit) => {
	rateUnit.unit = unit;
	document.documentElement.dataset.rate = unit;
	try {
		localStorage.setItem(RATE_KEY, unit);
	} catch {
		// Storage blocked: the choice lasts until the page is left.
	}
};
