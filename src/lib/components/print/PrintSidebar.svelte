<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import type { MadeItem } from '#lib/describe.js';
	import { formatRate, signalName } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';
	import type { PrintAnalysis } from '#lib/server/pipeline/analyze.js';
	import type { PrintDoc } from '#lib/server/pipeline/print-doc.js';
	import CountList from './CountList.svelte';
	import FactsTable from './FactsTable.svelte';
	import Screenshot from './Screenshot.svelte';

	/**
	 * The print page's sidebar: copy button, the author's screenshot, the facts table, main
	 * products with rates, recipes, entities and modules, and the analyzer's limits.
	 */
	let {
		print,
		analysis: a,
		main,
		title,
		copyLabel,
		oncopy,
		icons
	}: {
		print: PrintDoc['print'];
		analysis: PrintAnalysis;
		main: MadeItem[];
		/** The print's title as plain text. */
		title: string;
		copyLabel: string;
		oncopy: () => void;
		icons: IconSet;
	} = $props();
</script>

<aside class="space-y-6">
	<div class="space-y-2">
		<button onclick={oncopy} class="w-full rounded bg-amber-500 px-4 py-2 font-medium text-stone-950 hover:bg-amber-400">
			{copyLabel}
		</button>
	</div>

	{#if print.image_id}
		<Screenshot id={print.image_id} type={print.image_type} {title} />
	{/if}

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
	<CountList title="Entities" kind="entity" counts={a.entities} {icons} />
	{#if Object.keys(a.modules).length}<CountList title="Modules" kind="item" counts={a.modules} {icons} />{/if}

	<section class="rounded-lg border border-dashed border-stone-700 p-3 text-xs text-stone-500">
		<h2 class="mb-1 font-semibold text-stone-400">Analyzer v{a.analyzerVersion} limits</h2>
		<ul class="list-disc space-y-0.5 pl-4">
			{#each a.limits as l (l)}<li>{l}</li>{/each}
		</ul>
	</section>
</aside>
