<script lang="ts">
	import { CATEGORY_TITLE, pageCategoryHeadline, printCategoryHeadline } from '#lib/describe.js';
	import type { IconSet } from '#lib/icons.js';
	import type { Category, NodeAnalysis, PrintAnalysis } from '#lib/server/pipeline/analyze.js';
	import CountSection, { countRows, QUALITIES } from './CountSection.svelte';
	import QualityChips from './QualityChips.svelte';

	/**
	 * Everything a print is built from: a summary bar (entities, kinds, how many at each quality and a
	 * quality filter), then the entities grouped by category, the modules and
	 * the tiles, in two columns. In a book, a ScopeBar above it picks the whole book or one page.
	 */
	let {
		analysis: a,
		page = null,
		inBook = false,
		icons
	}: {
		analysis: PrintAnalysis;
		/** One page to count, else the whole print. */
		page?: NodeAnalysis | null;
		inBook?: boolean;
		icons: IconSet;
	} = $props();

	/** What the tab counts: the whole print, or the one page. */
	const src = $derived(
		page
			? { ...page, headline: (cat: Category) => pageCategoryHeadline(page, cat) }
			: { ...a, headline: (cat: Category) => printCategoryHeadline(a, cat) }
	);

	// Documents from before ANALYZER_VERSION 8 have no entitiesByQuality: all normal, as far as we know.
	const counts = $derived(src.entitiesByQuality ?? src.entities);
	const categoryOf = $derived(new Map(Object.entries(src.byCategory).flatMap(([cat, c]) => Object.keys(c ?? {}).map((name) => [name, cat]))));
	const byQuality = $derived.by(() => {
		const totals: Record<string, number> = {};
		for (const [key, n] of Object.entries(counts)) {
			const q = key.split('@')[1] ?? 'normal';
			totals[q] = (totals[q] ?? 0) + n;
		}
		return Object.entries(totals).sort(([x], [y]) => QUALITIES.indexOf(x) - QUALITIES.indexOf(y));
	});
	// Quality only means something from 2.0 on.
	const hasQuality = $derived((a.gameMajor ?? 0) >= 2);

	let quality = $state<string | null>(null);
	const groups = $derived.by(() => {
		const rows = countRows(counts, quality);
		return CATEGORY_TITLE.map(([cat, title]) => ({
			cat,
			title,
			rows: rows.filter((r) => (categoryOf.get(r.name) ?? 'other') === cat)
		}))
			.filter((g) => g.rows.length)
			.map((g) => ({
				...g,
				// Belts, trains, power and circuits say more than a count.
				note: (['belts', 'rail', 'power', 'circuits'].includes(g.cat) && !quality ? src.headline(g.cat) : '') ||
					g.rows.reduce((s, r) => s + r.total, 0).toLocaleString()
			}));
	});
	const modules = $derived(countRows(src.modules, quality));
	const tiles = $derived(quality ? [] : countRows(src.tiles));
	const kinds = $derived(Object.keys(src.entities).length);
</script>

<div class="space-y-6">
	<div class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-stone-800 bg-stone-900/40 px-4 py-3 text-sm">
		<p>
			<span class="font-semibold text-stone-100">{src.entityCount.toLocaleString()} entities · {kinds} kinds</span>
			<span class="text-stone-400">to build this {page ? 'page' : inBook ? 'book' : 'print'}{src.tileCount ? `, and ${src.tileCount.toLocaleString()} tiles` : ''}</span>
		</p>
		{#if hasQuality}
			<QualityChips totals={byQuality} bind:quality what="entities and modules" {icons} />
		{:else}
			<span class="text-xs text-stone-500">Quality: none before Factorio 2.0</span>
		{/if}
	</div>

	<div class="gap-10 sm:columns-2">
		{#each groups as g (g.cat)}
			<CountSection title={g.title} note={g.note} rows={g.rows} kind="entity" {icons} />
		{/each}
		{#if modules.length}
			<CountSection title="Modules" note={modules.reduce((s, r) => s + r.total, 0).toLocaleString()} rows={modules} kind="item" {icons} />
		{/if}
		{#if tiles.length}
			<CountSection title="Tiles" note={src.tileCount.toLocaleString()} rows={tiles} kind="tile" {icons} />
		{/if}
	</div>
	{#if quality && !groups.length && !modules.length}
		<p class="text-sm text-stone-500">Nothing at {quality} quality{page ? ' on this page' : ''}.</p>
	{:else if !groups.length && !modules.length && !tiles.length}
		<p class="text-sm text-stone-500">{page ? 'This page has' : 'It has'} no entities.</p>
	{/if}
</div>
