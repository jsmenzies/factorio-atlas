<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import type { infraCards } from '#lib/describe.js';
	import { signalName } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';
	import type { PrintAnalysis } from '#lib/server/pipeline/analyze.js';

	/** Belts, trains, power, defence and circuits across the whole print: a headline and the top entities. */
	let {
		cards,
		byCategory,
		heading,
		icons
	}: { cards: ReturnType<typeof infraCards>; byCategory: PrintAnalysis['byCategory']; heading: boolean; icons: IconSet } = $props();
</script>

<section class="space-y-2" aria-label="Infrastructure">
	{#if heading}<h2 class="font-semibold">Whole book</h2>{/if}
	<div class="grid gap-3 sm:grid-cols-2">
		{#each cards as card (card.cat)}
			<div class="rounded-lg border border-stone-800 p-3">
				<h3 class="text-xs font-semibold tracking-wide text-stone-400 uppercase">{card.title}</h3>
				<p class="mt-1 text-sm text-stone-200">{card.headline}</p>
				<ul class="mt-2 space-y-1 text-sm">
					{#each Object.entries(byCategory[card.cat] ?? {}).slice(0, 6) as [name, n] (name)}
						<li class="flex items-center gap-2">
							<Icon {icons} kind="entity" {name} label={signalName(name)} size={18} />
							<span class="min-w-0 flex-1 truncate text-stone-300">{signalName(name)}</span>
							<span class="text-stone-500">{n.toLocaleString()}</span>
						</li>
					{/each}
				</ul>
			</div>
		{/each}
	</div>
</section>
