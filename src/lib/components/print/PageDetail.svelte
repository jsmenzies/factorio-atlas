<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import Rate from '#lib/components/Rate.svelte';
	import RichText from '#lib/components/RichText.svelte';
	import { pageInfra, setupCounts, type IconCount } from '#lib/describe.js';
	import { signalName } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';
	import type { NodeAnalysis } from '#lib/server/pipeline/analyze.js';

	/** One blueprint page's facts: rates, what it takes from outside, how it's built, its size, the description saved in it. */
	let { page, icons }: { page: NodeAnalysis; icons: IconSet } = $props();

	const setup = $derived(setupCounts(page));
	const infra = $derived(pageInfra(page));
	/** What the page consumes from outside, with its nameplate rate when we know it. */
	const inputs = $derived(page.inputs.map((s) => ({ signal: s, rate: page.rates[s] < 0 ? -page.rates[s] : null })));
	// Long in-game descriptions (often changelogs) fold to a few lines.
	const long = $derived((page.description?.length ?? 0) > 280);
	let showAll = $state(false);
</script>

{#snippet counts(list: IconCount[], notes: string[] = [])}
	<dd class="flex flex-wrap items-center gap-x-3 gap-y-1 text-stone-300">
		{#each list as c (c.name + (c.quality ?? ''))}
			<span class="flex items-center gap-1 tabular-nums" title={c.label}>
				<span class="relative inline-block shrink-0">
					<Icon {icons} kind={c.kind} name={c.name} label={signalName(c.name)} size={20} />
					{#if c.quality}
						<span class="absolute -bottom-0.5 -left-0.5 leading-none">
							<Icon {icons} kind="quality" name={c.quality} label={signalName(c.quality)} size={10} />
						</span>
					{/if}
				</span>
				{c.n.toLocaleString()}
			</span>
		{/each}
		{#each notes as note (note)}
			<span class="text-stone-400"><RichText text={note} {icons} size={16} /></span>
		{/each}
	</dd>
{/snippet}

<dl class="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[7rem_1fr]">
	{#if page.claimedRate || page.estimatedRate}
		<dt class="text-stone-500">Rate</dt>
		<!-- Both rates are of the page's first output: the label's, and the most its machines make running flat out. -->
		<dd class="flex flex-wrap items-center gap-x-1.5 text-stone-200">
			{#if page.outputs[0]}
				<Icon {icons} signal={page.outputs[0]} label={signalName(page.outputs[0])} size={18} />
				<span class="mr-1">{signalName(page.outputs[0])}</span>
			{/if}
			{#if page.claimedRate}<span title="The rate in the page's label"><Rate value={page.claimedRate} /> claimed</span>{/if}
			{#if page.claimedRate && page.estimatedRate}<span class="text-stone-500">·</span>{/if}
			{#if page.estimatedRate}<span
					class="cursor-help underline decoration-stone-600 decoration-dotted underline-offset-4"
					title="Calculated: every machine crafting at full speed, with its modules and beacons. Belts, inserters and inputs may limit it in game."
					>≈ <Rate value={page.estimatedRate} /></span
				>{/if}
		</dd>
	{/if}
	{#if inputs.length}
		<dt class="text-stone-500">Takes</dt>
		<dd class="flex flex-wrap gap-x-3 gap-y-1">
			{#each inputs as t (t.signal)}
				<span class="flex items-center gap-1 text-stone-300">
					<Icon {icons} signal={t.signal} label={signalName(t.signal)} size={18} />
					{signalName(t.signal)}{#if t.rate}<span class="text-stone-500"><Rate value={t.rate} /></span>{/if}
				</span>
			{/each}
		</dd>
	{/if}
	{#if setup.length}
		<dt class="text-stone-500">Built with</dt>
		{@render counts(setup)}
	{/if}
	{#each infra as line (line.title)}
		<dt class="text-stone-500">{line.title}</dt>
		{@render counts(line.counts, line.notes)}
	{/each}
	<dt class="text-stone-500">Size</dt>
	<dd class="text-stone-300">
		{page.width && page.height ? `${page.width}×${page.height} tiles · ` : ''}{page.entityCount.toLocaleString()} entities{page.gameVersion
			? ` · Factorio ${page.gameVersion}`
			: ''}
	</dd>
	{#if page.description}
		<dt class="text-stone-500">Description</dt>
		<dd class="text-stone-300">
			<p class="whitespace-pre-line {long && !showAll ? 'line-clamp-4' : ''}"><RichText text={page.description} {icons} size={16} /></p>
			{#if long}
				<button type="button" class="text-xs text-amber-400 hover:text-amber-300" onclick={() => (showAll = !showAll)}>{showAll ? 'Show less' : 'Show all'}</button>
			{/if}
		</dd>
	{/if}
</dl>
