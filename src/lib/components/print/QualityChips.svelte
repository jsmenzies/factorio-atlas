<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import { signalName } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';

	/**
	 * One chip per quality with how many there are at it; a click shows only that quality, another
	 * click shows them all again. Used by the Produces, Entities and Recipes tabs.
	 */
	let {
		totals,
		quality = $bindable(),
		what,
		icons
	}: {
		/** Quality and count, in the game's order. */
		totals: [string, number][];
		quality: string | null;
		/** What is counted, for the tooltips ("entities and modules"). */
		what: string;
		icons: IconSet;
	} = $props();
</script>

<div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Show one quality">
	{#each totals as [q, n] (q)}
		{@const on = quality === q}
		<button
			type="button"
			aria-pressed={on}
			onclick={() => (quality = on ? null : q)}
			title={on ? 'Show every quality' : `Show only ${q} ${what}`}
			class="flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm {on
				? 'border-amber-500/60 bg-amber-500/10 text-amber-200'
				: 'border-stone-700 text-stone-300 hover:border-stone-500'}"
		>
			<Icon {icons} kind="quality" name={q} label="" size={14} />{signalName(q)}
			<span class="text-stone-500 tabular-nums">{n.toLocaleString()}</span>
		</button>
	{/each}
</div>
