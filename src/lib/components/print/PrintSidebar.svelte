<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import type { MadeItem } from '#lib/describe.js';
	import { formatRate, signalName } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';
	import type { PrintAnalysis } from '#lib/server/pipeline/analyze.js';
	import CountList from './CountList.svelte';
	import FactsTable from './FactsTable.svelte';

	/**
	 * The print page's sidebar: the facts table, main products with rates, recipes, entities,
	 * modules and tiles, and the analyzer's limits. The copy button and the author's screenshot
	 * are in the header (PrintHero).
	 */
	let {
		analysis: a,
		main,
		icons
	}: {
		analysis: PrintAnalysis;
		main: MadeItem[];
		icons: IconSet;
	} = $props();
</script>

<aside class="space-y-6">
	<FactsTable analysis={a} />

	{#if main.length}
		<section>
			<h2
				class="mb-2 text-xs font-semibold tracking-wide text-stone-400 uppercase"
				title="Best single page's rate: claimed by the author, or ≈ nameplate with every machine running flat out"
			>
				Main products
			</h2>
			<ul class="space-y-1 text-sm">
				{#each main as m (m.signal)}
					<li class="flex items-center gap-2">
						<Icon {icons} signal={m.signal} label={signalName(m.signal)} />
						<span class="min-w-0 flex-1 truncate">{signalName(m.signal)}</span>
						{#if m.rate}
							<span class="text-emerald-300">{m.claimed ? '' : '≈ '}{formatRate(m.rate)}</span>
						{:else}
							<span class="text-xs text-stone-500" title="Smelting and mining are not rated yet">not rated</span>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if Object.keys(a.recipes).length}<CountList title="Recipes (machines)" kind="recipe" counts={a.recipes} {icons} />{/if}
	<!-- Documents from before ANALYZER_VERSION 8 have no entitiesByQuality. -->
	<CountList title="Entities" kind="entity" counts={a.entitiesByQuality ?? a.entities} {icons} />
	{#if Object.keys(a.modules).length}<CountList title="Modules" kind="item" counts={a.modules} {icons} />{/if}
	{#if Object.keys(a.tiles).length}<CountList title="Tiles" kind="tile" counts={a.tiles} {icons} />{/if}

	<section class="rounded-lg border border-dashed border-stone-700 p-3 text-xs text-stone-500">
		<h2 class="mb-1 font-semibold text-stone-400">Analyzer v{a.analyzerVersion} limits</h2>
		<ul class="list-disc space-y-0.5 pl-4">
			{#each a.limits as l (l)}<li>{l}</li>{/each}
		</ul>
	</section>
</aside>
