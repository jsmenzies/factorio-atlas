<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import Rate from '#lib/components/Rate.svelte';
	import { signalName } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';
	import type { NodeAnalysis } from '#lib/server/pipeline/analyze.js';

	/**
	 * What a print takes from outside: one row per item. A single blueprint shows each one's
	 * nameplate rate; a book can't (each page assumes its own supply), so it says how many pages
	 * take it, and clicking shows them.
	 */
	let {
		inputs,
		pages,
		single,
		onpick,
		icons
	}: {
		inputs: string[];
		pages: NodeAnalysis[];
		/** The one page of a single blueprint, whose rates apply. */
		single: NodeAnalysis | null;
		onpick?: (signal: string) => void;
		icons: IconSet;
	} = $props();

	const taking = (signal: string) => pages.filter((n) => n.inputs.includes(signal)).length;
	// Rated first, then by how many pages take it, then by name.
	const rows = $derived(
		inputs
			.map((signal) => ({ signal, rate: single && single.rates[signal] < 0 ? -single.rates[signal] : null, pages: taking(signal) }))
			.sort((x, y) => (y.rate ?? 0) - (x.rate ?? 0) || y.pages - x.pages || signalName(x.signal).localeCompare(signalName(y.signal)))
	);
</script>

<div class="space-y-3">
	<p class="text-sm text-stone-400">
		{single
			? 'What this blueprint needs fed in, with every machine crafting at full speed.'
			: 'What the pages need fed in. Whole-book inputs are not rated: each page assumes its own supply. Pick This page above for one page’s inputs at its rates.'}
	</p>
	<ul class="divide-y divide-stone-800 border-y border-stone-800 text-sm lg:max-w-2xl">
		{#each rows as r (r.signal)}
			<li class="flex items-center gap-3 py-2">
				<Icon {icons} signal={r.signal} label={signalName(r.signal)} size={28} />
				<span class="min-w-0 flex-1 truncate text-stone-200">{signalName(r.signal)}</span>
				{#if single}
					<span class="tabular-nums {r.rate ? 'text-amber-200' : 'text-stone-500'}" title={r.rate ? 'Taken in with every machine crafting at full speed' : 'Not rated: smelting and mining are not rated yet'}
						>{#if r.rate}<Rate value={r.rate} />{:else}—{/if}</span
					>
				{:else if onpick}
					<button
						type="button"
						onclick={() => onpick(r.signal)}
						class="rounded px-2 py-0.5 text-stone-400 hover:bg-stone-800 hover:text-amber-300"
						title="Find the pages that take {signalName(r.signal)}">on {r.pages} page{r.pages === 1 ? '' : 's'} →</button
					>
				{/if}
			</li>
		{/each}
	</ul>
</div>
