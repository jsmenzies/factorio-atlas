<script lang="ts">
	import type { RateUnit } from '#lib/format.js';
	import { rateUnit, setRateUnit } from '#lib/rate-unit.svelte.js';

	/** Per second or per minute, for every rate on the site. The highlight follows `<html data-rate>` (CSS), so it's right before hydration too. */
	const UNITS: [RateUnit, string, string][] = [
		['s', '/s', 'Rates per second'],
		['min', '/min', 'Rates per minute']
	];
</script>

<div class="flex items-center gap-2 text-xs" role="group" aria-label="Rate unit">
	<span class="hidden text-stone-500 sm:inline">Rates</span>
	<div class="flex rounded-md border border-stone-700 p-0.5">
		{#each UNITS as [unit, text, title] (unit)}
			<button
				type="button"
				data-unit={unit}
				aria-pressed={rateUnit.unit === unit}
				{title}
				onclick={() => setRateUnit(unit)}
				class="rate-unit rounded px-2 py-1 font-mono text-stone-400 hover:text-amber-300">{text}</button
			>
		{/each}
	</div>
</div>
