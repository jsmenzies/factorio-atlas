<script lang="ts" module>
	import type { Role } from '#lib/server/pipeline/analyze.js';

	/** Finding a page in a big book: by what it makes (a clicked product) or its role. */
	export type PageFilter = { kind: 'item'; signal: string } | { kind: 'role'; role: Role } | null;
</script>

<script lang="ts">
	import BookPages from '#lib/components/BookPages.svelte';
	import { pageTitle, ROLE_LABEL } from '#lib/describe.js';
	import { signalName } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';
	import { plainText } from '#lib/richtext.js';
	import type { NodeAnalysis } from '#lib/server/pipeline/analyze.js';

	/** A book's pages: a search box (name or item), the active filter as a removable chip, then the page tabs. */
	let {
		pages,
		books,
		selected,
		onselect,
		filter,
		onclearfilter,
		icons
	}: {
		pages: NodeAnalysis[];
		books: NodeAnalysis[];
		selected: string;
		onselect: (path: string) => void;
		filter: PageFilter;
		onclearfilter: () => void;
		icons: IconSet;
	} = $props();

	let query = $state('');
	const makesItem = (n: NodeAnalysis, signal: string) => n.outputs.includes(signal) || n.products.includes(signal);
	const shownPages = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return pages.filter(
			(n) =>
				(!filter || (filter.kind === 'item' ? makesItem(n, filter.signal) : n.role === filter.role)) &&
				(!q ||
					plainText(pageTitle(n).text).toLowerCase().includes(q) ||
					[...n.outputs, ...n.products].some((s) => signalName(s).toLowerCase().includes(q)))
		);
	});
	const filterLabel = $derived(
		filter?.kind === 'item' ? `Makes ${signalName(filter.signal)}` : filter?.kind === 'role' ? `${ROLE_LABEL[filter.role]} pages` : ''
	);
</script>

<section class="space-y-3" aria-label="Pages">
	<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
		<h2 class="font-semibold">Pages <span class="text-sm font-normal text-stone-500">{pages.length}</span></h2>
		<label class="flex min-w-48 flex-1 items-center gap-2 rounded border border-stone-700 bg-stone-900 px-2 py-1 text-sm sm:max-w-xs">
			<span class="sr-only">Find a page</span>
			<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-stone-500"
				><circle cx="11" cy="11" r="7" /><line x1="16.5" y1="16.5" x2="21" y2="21" /></svg
			>
			<input bind:value={query} placeholder="Find a page: name or item" class="min-w-0 flex-1 bg-transparent placeholder:text-stone-500 focus:outline-none" />
		</label>
		{#if filter}
			<button
				type="button"
				onclick={onclearfilter}
				class="flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-sm text-amber-200 hover:bg-amber-500/20"
				aria-label="Remove filter: {filterLabel}">{filterLabel} <span class="text-amber-400">×</span></button
			>
		{/if}
		{#if filter || query.trim()}<span class="text-sm text-stone-500">{shownPages.length} of {pages.length}</span>{/if}
	</div>
	{#if shownPages.length}
		<BookPages pages={shownPages} {books} {selected} {onselect} {icons} />
	{:else}
		<p class="rounded border border-dashed border-stone-700 p-4 text-sm text-stone-500">No pages match. Clear the filter or search to see them all.</p>
	{/if}
</section>
