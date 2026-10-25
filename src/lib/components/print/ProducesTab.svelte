<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import Rate from '#lib/components/Rate.svelte';
	import RichText from '#lib/components/RichText.svelte';
	import { GROUP_ORDER, type MadeItem, type ProductGroup } from '#lib/describe.js';
	import { formatRate, signalName } from '#lib/format.js';
	import { rateUnit } from '#lib/rate-unit.svelte.js';
	import type { IconSet } from '#lib/icons.js';
	import { countRows, QUALITIES } from './CountSection.svelte';
	import QualityChips from './QualityChips.svelte';

	/**
	 * Everything a print makes, by crafting-menu section (mall and shop products together, under one
	 * subheading per crafting-menu tab), in the game's own order: one row per item with its rate, then
	 * what is made and used up inside. A
	 * search box, section chips and quality chips (the quality machines craft at) narrow it; an item
	 * made above normal quality has the game's badge. In a book, clicking an item finds its pages.
	 */
	let {
		main,
		groups,
		sections,
		order = {},
		intermediates,
		byQuality = {},
		empty = null,
		onpick,
		icons
	}: {
		main: MadeItem[];
		groups: ProductGroup[];
		/** Crafting-menu section per signal. */
		sections: Record<string, string>;
		/** The crafting menu's sort key per signal (tab|row|item). */
		order?: Record<string, string>;
		/** Made and consumed inside the print, never leaving it. */
		intermediates: string[];
		/** Machines per product and recipe quality (`item:name@quality`, plain for normal). */
		byQuality?: Record<string, number>;
		/** Said in place of the lists when there is nothing at all to show. */
		empty?: string | null;
		onpick?: (signal: string) => void;
		icons: IconSet;
	} = $props();

	const keyOf = (signal: string) => order[signal] ?? 'z|z|';
	const inMenuOrder = <T,>(items: T[], signal: (t: T) => string) =>
		items.toSorted((x, y) => (keyOf(signal(x)) < keyOf(signal(y)) ? -1 : keyOf(signal(x)) > keyOf(signal(y)) ? 1 : 0));
	/** A section's items in blocks: a mall's by crafting-menu tab, in the menu's order (headed when there are several), others one block. */
	const blocksOf = (name: string, items: MadeItem[]) => {
		if (name !== 'Mall & shops') return [{ name: null, items }];
		const byTab = new Map<string, MadeItem[]>();
		for (const m of items) byTab.set(sections[m.signal] ?? 'Other', [...(byTab.get(sections[m.signal] ?? 'Other') ?? []), m]);
		const blocks = [...byTab].map(([tab, items]) => ({ name: tab as string | null, items }));
		// Items come sorted, so each block's first item gives its tab's place in the menu.
		return blocks.length > 1 ? inMenuOrder(blocks, (b) => b.items[0].signal) : [{ name: null, items }];
	};

	const all = $derived.by(() => {
		const bySection = new Map<string, MadeItem[]>();
		const add = (name: string, m: MadeItem) => bySection.set(name, [...(bySection.get(name) ?? []), m]);
		for (const m of main) add(sections[m.signal] ?? 'Other', m);
		for (const g of groups) for (const m of g.items) add(g.name, m);
		return [...bySection]
			.map(([name, items]) => ({ name, items: inMenuOrder(items, (m) => m.signal) }))
			.sort((x, y) => GROUP_ORDER.indexOf(x.name) - GROUP_ORDER.indexOf(y.name));
	});
	const total = $derived(all.reduce((s, g) => s + g.items.length, 0));

	// Each item's qualities, lowest first; an item no machine crafts (an icon, a mall page's) counts as normal.
	const parts = $derived(new Map(countRows(byQuality).map((r) => [r.name, r.parts])));
	const levelsOf = (signal: string) => parts.get(signal)?.map((p) => p.quality) ?? ['normal'];
	const qualityTotals = $derived.by(() => {
		const totals = new Map<string, number>();
		const signals = [...all.flatMap((g) => g.items.map((m) => m.signal)), ...intermediates];
		for (const s of signals) for (const q of levelsOf(s)) totals.set(q, (totals.get(q) ?? 0) + 1);
		return [...totals].sort(([x], [y]) => QUALITIES.indexOf(x) - QUALITIES.indexOf(y));
	});
	let quality = $state<string | null>(null);
	/** The badge on an item: the quality picked, else the highest it's made at. */
	const badgeOf = (signal: string) => quality ?? levelsOf(signal).at(-1);

	let section = $state<string | null>(null);
	let query = $state('');
	const shown = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return all
			.filter((g) => !section || g.name === section)
			.map((g) => ({
				...g,
				items: g.items.filter((m) => (!q || signalName(m.signal).toLowerCase().includes(q)) && (!quality || levelsOf(m.signal).includes(quality)))
			}))
			.filter((g) => g.items.length);
	});
	const inside = $derived(!section && !query.trim() ? inMenuOrder(intermediates, (s) => s).filter((s) => !quality || levelsOf(s).includes(quality)) : []);

	const madeAt = (signal: string) => {
		const ps = parts.get(signal);
		return ps?.some((p) => p.quality !== 'normal') ? ` Made at ${ps.map((p) => `${p.quality} (${p.n} machine${p.n === 1 ? '' : 's'})`).join(', ')}.` : '';
	};
	const tip = (m: MadeItem) =>
		`${signalName(m.signal)}${m.rate ? `: ${m.claimed ? 'claimed' : 'calculated'} ${formatRate(m.rate, rateUnit.unit)}` : ': not rated'}${
			m.pages.length > 1 ? `, best of ${m.pages.length} pages` : ''
		}.${madeAt(m.signal)}${onpick ? ' Click to find the pages that make it.' : ''}`;
</script>

<!-- One row per item, as the Entities tab's lists: icon, name, rate on the right. -->
{#snippet row(signal: string, title: string, made: MadeItem | null, pick: ((signal: string) => void) | null | undefined = onpick)}
	{@const best = badgeOf(signal)}
	<li class="break-inside-avoid">
		<svelte:element
			this={pick ? 'button' : 'div'}
			role={pick ? 'button' : undefined}
			type={pick ? 'button' : undefined}
			onclick={pick ? () => pick(signal) : undefined}
			{title}
			class="group flex w-full items-center gap-2.5 py-1 text-left"
		>
			<span class="relative inline-block shrink-0">
				<Icon {icons} {signal} label={signalName(signal)} size={24} />
				{#if best && best !== 'normal'}
					<span class="absolute -bottom-0.5 -left-0.5 leading-none"><Icon {icons} kind="quality" name={best} label={signalName(best)} size={11} /></span>
				{/if}
			</span>
			<span class="min-w-0 flex-1 truncate text-stone-200 {pick ? 'group-hover:text-amber-300' : ''}">{signalName(signal)}</span>
			{#if made}<span class="shrink-0 text-right tabular-nums {made.rate ? 'text-stone-300' : 'text-stone-500'}"
					>{#if made.rate}{made.claimed ? '' : '≈ '}<Rate value={made.rate} />{:else}—{/if}</span
				>{/if}
		</svelte:element>
	</li>
{/snippet}

{#snippet list(items: MadeItem[], label: string, columns: string)}
	<ul class="mt-1.5 gap-10 text-sm {columns}" aria-label={label}>
		{#each items as m (m.signal)}{@render row(m.signal, tip(m), m)}{/each}
	</ul>
{/snippet}

{#if empty && !total && !intermediates.length}
	<p class="rounded border border-dashed border-stone-700 p-4 text-sm text-stone-400"><RichText text={empty} {icons} size={16} /></p>
{:else}
<div class="@container space-y-6">
	<div class="flex flex-wrap items-center gap-2">
		<label class="flex min-w-48 flex-1 items-center gap-2 rounded border border-stone-700 bg-stone-900 px-2 py-1 text-sm sm:max-w-xs">
			<span class="sr-only">Find an item</span>
			<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-stone-500"
				><circle cx="11" cy="11" r="7" /><line x1="16.5" y1="16.5" x2="21" y2="21" /></svg
			>
			<input bind:value={query} placeholder="Find an item" class="min-w-0 flex-1 bg-transparent placeholder:text-stone-500 focus:outline-none" />
		</label>
		{#if all.length > 1}
			<div class="flex flex-wrap gap-1.5 text-sm" role="group" aria-label="Show one section">
				{#each [{ name: null, n: total }, ...all.map((g) => ({ name: g.name, n: g.items.length }))] as chip (chip.name)}
					{@const on = section === chip.name}
					<button
						type="button"
						aria-pressed={on}
						onclick={() => (section = chip.name)}
						class="rounded-full border px-2.5 py-0.5 {on ? 'border-amber-500/60 bg-amber-500/10 text-amber-200' : 'border-stone-700 text-stone-300 hover:border-stone-500'}"
					>
						{chip.name ?? 'All'} <span class="text-stone-500">{chip.n}</span>
					</button>
				{/each}
			</div>
		{/if}
		{#if qualityTotals.some(([q]) => q !== 'normal')}
			<QualityChips totals={qualityTotals} bind:quality what="items (the quality machines craft at)" {icons} />
		{/if}
	</div>

	{#each shown as g (g.name)}
		{@const rated = g.items.filter((m) => m.rate)}
		{@const blocks = blocksOf(g.name, g.items)}
		<section>
			<h3 class="flex items-baseline justify-between gap-3 border-b border-stone-800 pb-2">
				<span class="font-semibold text-stone-100">{g.name} <span class="text-sm font-normal text-stone-500">{g.items.length}</span></span>
				<span class="text-xs text-stone-400">{rated.length === g.items.length ? 'all rated' : `${rated.length} rated`}</span>
			</h3>
			{#if blocks.length > 1}
				<div class="mt-3 gap-10 @3xl:columns-2">
					{#each blocks as b (b.name)}
						<div class="break-inside-avoid pb-5">
							<h4 class="flex items-baseline justify-between gap-3 border-b border-stone-800/70 pb-1 text-xs font-semibold tracking-wide text-stone-400 uppercase">
								<span>{b.name}</span><span class="font-normal tabular-nums">{b.items.length}</span>
							</h4>
							{@render list(b.items, `${g.name}: ${b.name}`, '')}
						</div>
					{/each}
				</div>
			{:else}
				{@render list(g.items, g.name, '@lg:columns-2 @5xl:columns-3')}
			{/if}
		</section>
	{:else}
		{#if !inside.length}<p class="rounded border border-dashed border-stone-700 p-4 text-sm text-stone-500">No items match.</p>{/if}
	{/each}

	{#if inside.length}
		<section>
			<h3 class="flex items-baseline justify-between gap-3 border-b border-stone-800 pb-2">
				<span class="font-semibold text-stone-100">Made and used inside <span class="text-sm font-normal text-stone-500">{inside.length}</span></span>
				<span class="text-xs text-stone-400">intermediates that never leave the page</span>
			</h3>
			<ul class="mt-1.5 gap-10 text-sm @lg:columns-2 @5xl:columns-3">
				{#each inside as s (s)}{@render row(s, `${signalName(s)}.${madeAt(s)}`, null, null)}{/each}
			</ul>
		</section>
	{/if}

	<p class="text-xs text-stone-500">
		Rates are calculated with every machine crafting at full speed (no research productivity), or the author's own when the page's name states one; a book shows its best
		single page's rate, never a sum.{onpick ? ' Click an item to see the pages that make it.' : ''}
	</p>
</div>
{/if}
