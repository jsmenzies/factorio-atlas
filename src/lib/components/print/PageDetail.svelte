<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import { describeSetup, pageInfra } from '#lib/describe.js';
	import { formatRate, signalName } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';
	import type { NodeAnalysis } from '#lib/server/pipeline/analyze.js';

	/** One blueprint page's facts: rates, what it takes from outside, how it's built, its size. */
	let { page, icons }: { page: NodeAnalysis; icons: IconSet } = $props();

	const setup = $derived(describeSetup(page));
	const infra = $derived(pageInfra(page));
	/** What the page consumes from outside, with its nameplate rate when we know it. */
	const inputs = $derived(page.inputs.map((s) => ({ signal: s, rate: page.rates[s] < 0 ? -page.rates[s] : null })));
</script>

<dl class="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[7rem_1fr]">
	{#if page.claimedRate || page.estimatedRate}
		<dt class="text-stone-500">Rate</dt>
		<dd class="text-stone-200">
			{#if page.claimedRate}{formatRate(page.claimedRate)} claimed{/if}{#if page.claimedRate && page.estimatedRate}<span class="text-stone-500"> · </span
				>{/if}{#if page.estimatedRate}≈ {formatRate(page.estimatedRate)} nameplate{/if}
		</dd>
	{/if}
	{#if inputs.length}
		<dt class="text-stone-500">Takes</dt>
		<dd class="flex flex-wrap gap-x-3 gap-y-1">
			{#each inputs as t (t.signal)}
				<span class="flex items-center gap-1 text-stone-300">
					<Icon {icons} signal={t.signal} label={signalName(t.signal)} size={18} />
					{signalName(t.signal)}{#if t.rate}<span class="text-stone-500">{formatRate(t.rate)}</span>{/if}
				</span>
			{/each}
		</dd>
	{/if}
	{#if setup}
		<dt class="text-stone-500">Built with</dt>
		<dd class="text-stone-300">{setup}</dd>
	{/if}
	{#each infra as line (line.title)}
		<dt class="text-stone-500">{line.title}</dt>
		<dd class="text-stone-300">{line.text}</dd>
	{/each}
	<dt class="text-stone-500">Size</dt>
	<dd class="text-stone-300">
		{page.width && page.height ? `${page.width}×${page.height} tiles · ` : ''}{page.entityCount.toLocaleString()} entities{page.gameVersion
			? ` · Factorio ${page.gameVersion}`
			: ''}
	</dd>
</dl>
