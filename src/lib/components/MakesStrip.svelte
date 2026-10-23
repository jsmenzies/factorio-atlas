<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import type { MadeItem, ProductGroup } from '#lib/describe.js';
	import { formatRate, signalName } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';

	/**
	 * What a print makes: main products with the best page's rate, then the rest folded into
	 * groups ("Intermediates 9", "Mall & shops 27") that open in place. Each item is its icon and
	 * rate in a plain row; the name (and how many pages make it) is the tooltip, and the icon's alt
	 * text names it for screen readers. With `onpick`, items are buttons that filter the page grid
	 * to the pages making them. `tiles` is the print header's one-line form: "Makes", each main
	 * product as a framed icon, then the groups as "+ intermediates" links.
	 */
	let {
		main,
		groups,
		icons,
		active = null,
		onpick,
		tiles = false
	}: { main: MadeItem[]; groups: ProductGroup[]; icons: IconSet; active?: string | null; onpick?: (signal: string) => void; tiles?: boolean } = $props();

	const rated = $derived(main.some((m) => m.rate));

	let open = $state<string | null>(null);
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
		class="flex items-center gap-1 rounded px-1 py-0.5 text-left {small ? 'text-xs' : 'text-sm'} {pressed
			? 'bg-amber-500/15 ring-1 ring-amber-500/60'
			: ''} {onpick ? 'hover:bg-stone-800' : ''}"
	>
		<Icon {icons} signal={m.signal} label={signalName(m.signal)} size={small ? 20 : 24} />
		{#if m.rate}<span class="text-emerald-300">{m.claimed ? '' : '≈ '}{formatRate(m.rate)}</span>{/if}
	</svelte:element>
{/snippet}

{#snippet tile(m: MadeItem)}
	{@const pressed = active === m.signal}
	<svelte:element
		this={onpick ? 'button' : 'span'}
		role={onpick ? undefined : 'listitem'}
		type={onpick ? 'button' : undefined}
		aria-pressed={onpick ? pressed : undefined}
		onclick={onpick ? () => onpick(m.signal) : undefined}
		title={tip(m)}
		class="flex items-center gap-1.5 text-sm"
	>
		<span
			class="grid size-10 place-items-center rounded border bg-stone-900/80 {pressed
				? 'border-amber-500 ring-1 ring-amber-500/60'
				: 'border-stone-700'} {onpick ? 'hover:border-stone-500' : ''}"
		>
			<Icon {icons} signal={m.signal} label={signalName(m.signal)} size={30} />
		</span>
		{#if m.rate}<span class="text-emerald-300">{m.claimed ? '' : '≈ '}{formatRate(m.rate)}</span>{/if}
	</svelte:element>
{/snippet}

{#snippet panels()}
	{#each groups as g (g.name)}
		{#if open === g.name}
			<div class="flex flex-wrap gap-x-2 gap-y-1 rounded-md border border-stone-800 bg-stone-900/80 p-2" role={onpick ? 'group' : 'list'} aria-label={g.name}>
				{#each g.items as m (m.signal)}{@render chip(m, true)}{/each}
			</div>
		{/if}
	{/each}
{/snippet}

{#if tiles}
	<div class="space-y-2">
		<div class="flex flex-wrap items-center gap-x-2 gap-y-1.5">
			<span class="mr-1 text-stone-300">Makes</span>
			<div class="contents" role={onpick ? 'group' : 'list'} aria-label="Main products">
				{#each main as m (m.signal)}{@render tile(m)}{/each}
			</div>
			<span class="ml-1 text-stone-400">
				{#each groups as g, i (g.name)}{i ? ' · ' : ''}<button
						type="button"
						aria-expanded={open === g.name}
						onclick={() => (open = open === g.name ? null : g.name)}
						title="{g.items.length} more: show them"
						class="hover:text-amber-300 {open === g.name ? 'text-stone-100' : ''}">{main.length && !i ? '+ ' : ''}{g.name.toLowerCase()}</button
					>{/each}{#if main.length && !rated}{groups.length ? ' · ' : ''}<span title="Smelting, mining and logistics are not rated yet">not rated</span>{/if}
			</span>
		</div>
		{@render panels()}
	</div>
{:else}
	<div class="space-y-2">
		{#if main.length}
			<div class="flex flex-wrap gap-x-3 gap-y-1" role={onpick ? 'group' : 'list'} aria-label="Main products">
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
			{@render panels()}
		{/if}
	</div>
{/if}
