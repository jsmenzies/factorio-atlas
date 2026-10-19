<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import type { MadeItem, ProductGroup } from '#lib/describe.js';
	import { formatRate, signalName } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';

	/**
	 * What a print makes: main products with the best page's rate, then the rest folded into
	 * groups ("Intermediates 9", "Mall & shops 27") that open in place. With `onpick`, items
	 * are buttons that filter the page grid to the pages making them.
	 */
	let {
		main,
		groups,
		icons,
		active = null,
		onpick
	}: { main: MadeItem[]; groups: ProductGroup[]; icons: IconSet; active?: string | null; onpick?: (signal: string) => void } = $props();

	let open = $state<string | null>(null);
	const bare = (s: string) => s.slice(s.indexOf(':') + 1);
	const tip = (m: MadeItem) =>
		`${signalName(m.signal)}${m.rate ? `: ${m.claimed ? 'claimed' : 'nameplate estimate'} ${formatRate(m.rate)}` : ': no rate (smelting and mining are not rated yet)'}${
			m.pages.length > 1 ? `, best of ${m.pages.length} pages` : ''
		}${onpick ? '. Click to show the pages that make it.' : ''}`;
</script>

{#snippet chip(m: MadeItem, small: boolean)}
	{@const pressed = active === m.signal}
	<svelte:element
		this={onpick ? 'button' : 'span'}
		role={onpick ? undefined : 'listitem'}
		type={onpick ? 'button' : undefined}
		aria-pressed={onpick ? pressed : undefined}
		onclick={onpick ? () => onpick(m.signal) : undefined}
		title={tip(m)}
		class="flex items-center gap-2 rounded-md border text-left {small ? 'py-0.5 pr-2 pl-1 text-xs' : 'py-1 pr-2.5 pl-1.5 text-sm'} {pressed
			? 'border-amber-500/70 bg-amber-500/10'
			: 'border-stone-800 bg-stone-950/60'} {onpick ? 'hover:border-stone-600' : ''}"
	>
		<Icon {icons} kind="item" name={bare(m.signal)} label={signalName(m.signal)} size={small ? 18 : 24} />
		<span class="text-stone-200">{signalName(m.signal)}</span>
		{#if m.rate}<span class="text-emerald-300">{m.claimed ? '' : '≈ '}{formatRate(m.rate)}</span>{/if}
		{#if m.pages.length > 1}<span class="text-xs text-stone-500">×{m.pages.length}</span>{/if}
	</svelte:element>
{/snippet}

<div class="space-y-2">
	{#if main.length}
		<div class="flex flex-wrap gap-2" role={onpick ? 'group' : 'list'} aria-label="Main products">
			{#each main as m (m.signal)}{@render chip(m, false)}{/each}
		</div>
	{/if}
	{#if groups.length}
		<div class="flex flex-wrap items-center gap-1.5 text-sm" role="group" aria-label="Also makes">
			<span class="text-stone-500">{main.length ? 'Also makes' : 'Makes'}</span>
			{#each groups as g (g.name)}
				<button
					type="button"
					aria-expanded={open === g.name}
					onclick={() => (open = open === g.name ? null : g.name)}
					class="rounded border px-2 py-0.5 {open === g.name
						? 'border-stone-500 bg-stone-800 text-stone-100'
						: 'border-stone-800 text-stone-300 hover:border-stone-600'}"
				>
					{g.name} <span class="text-stone-500">{g.items.length}</span>
					<span aria-hidden="true" class="text-stone-500">{open === g.name ? '▴' : '▾'}</span>
				</button>
			{/each}
		</div>
		{#each groups as g (g.name)}
			{#if open === g.name}
				<div class="flex flex-wrap gap-1.5 rounded-md border border-stone-800 bg-stone-900/40 p-2" role={onpick ? 'group' : 'list'} aria-label={g.name}>
					{#each g.items as m (m.signal)}{@render chip(m, true)}{/each}
				</div>
			{/if}
		{/each}
	{/if}
</div>
