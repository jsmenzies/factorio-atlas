<script lang="ts" module>
	import type { Role } from '#lib/server/pipeline/analyze.js';

	/** Finding a page in a big book by its role (a role chip). */
	export type PageFilter = { kind: 'role'; role: Role } | null;
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import BookPages from '#lib/components/BookPages.svelte';
	import RichText from '#lib/components/RichText.svelte';
	import { pageTitle, ROLE_LABEL } from '#lib/describe.js';
	import { signalName } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';
	import { plainText } from '#lib/richtext.js';
	import type { NodeAnalysis } from '#lib/server/pipeline/analyze.js';
	import type { PageThumb } from '#lib/viewer/thumbs.js';
	import PrintChips from './PrintChips.svelte';

	/**
	 * A book's pages around the selected page (`children`): above it the page count, a search box
	 * (name or item), the active filter as a removable chip, role chips and, with sub-books, the
	 * trail to the selected page's book; below it the sub-book chips and the page grid, which the
	 * search and filters narrow.
	 */
	let {
		pages,
		books,
		rootTitle,
		selected,
		href,
		onselect,
		filter,
		onclearfilter,
		roles,
		onrole,
		thumbs,
		icons,
		children
	}: {
		pages: NodeAnalysis[];
		books: NodeAnalysis[];
		/** The print's own book, first in the sub-book trail. */
		rootTitle: string;
		selected: string;
		/** A book page's URL. */
		href: (path: string) => string;
		onselect: (path: string) => void;
		filter: PageFilter;
		onclearfilter: () => void;
		/** Pages per role, as chips that filter to one. */
		roles: Record<string, number>;
		onrole: (role: Role) => void;
		thumbs: Record<string, PageThumb>;
		icons: IconSet;
		/** The selected page's card, between the search and the grid. */
		children: Snippet;
	} = $props();

	const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');
	/** The selected page's books from the print's own down, when it has sub-books. */
	const trail = $derived.by(() => {
		if (books.length < 2) return [];
		const chain: string[] = [];
		for (let at = parentOf(selected); at; at = parentOf(at)) {
			const book = books.find((b) => b.path === at);
			chain.unshift(book ? pageTitle(book).text : 'Untitled');
		}
		return [rootTitle, ...chain];
	});
	const inBook = $derived(pages.filter((n) => parentOf(n.path) === parentOf(selected)).length);

	let query = $state('');
	const shownPages = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return pages.filter(
			(n) =>
				(!filter || n.role === filter.role) &&
				(!q ||
					plainText(pageTitle(n).text).toLowerCase().includes(q) ||
					[...n.outputs, ...n.products].some((s) => signalName(s).toLowerCase().includes(q)))
		);
	});
	const filterLabel = $derived(filter ? `${ROLE_LABEL[filter.role]} pages` : '');
</script>

<section class="space-y-4" aria-label="Pages">
	<!-- Row 1: the heading, any filter, and the search box on the right. Row 2: where the page is in
	the book (the trail) on the left, the role chips under the search box on the right. -->
	<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
		<h2 class="text-xl font-semibold text-stone-50">
			Pages <span class="font-mono text-base font-normal text-stone-500">{pages.length}{books.length > 1 ? ` in ${books.length} books` : ''}</span>
		</h2>
		{#if filter}
			<button
				type="button"
				onclick={onclearfilter}
				class="flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-sm text-amber-200 hover:bg-amber-500/20"
				aria-label="Remove filter: {filterLabel}">{filterLabel} <span class="text-amber-400">×</span></button
			>
		{/if}
		{#if filter || query.trim()}<span class="text-sm text-stone-500">{shownPages.length} of {pages.length}</span>{/if}
		<label class="flex w-full items-center gap-2 rounded-md border border-stone-700 bg-stone-900 px-3 py-1.5 text-sm sm:ml-auto sm:w-80">
			<span class="sr-only">Find a page</span>
			<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-stone-500"
				><circle cx="11" cy="11" r="7" /><line x1="16.5" y1="16.5" x2="21" y2="21" /></svg
			>
			<input bind:value={query} placeholder="Find a page: name or item" class="min-w-0 flex-1 bg-transparent placeholder:text-stone-500 focus:outline-none" />
		</label>
	</div>
	{#if trail.length || Object.keys(roles).length > 1}
		<div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
			{#if trail.length}
				<p class="min-w-0 truncate text-stone-400">
					{#each trail as b, i (i)}{#if i}<span class="mx-1.5 text-stone-600">›</span>{/if}<span class={i === trail.length - 1 ? 'font-semibold text-stone-100' : ''}
							><RichText text={b} {icons} size={16} /></span
						>{/each}
					<span class="ml-1 font-mono text-sm text-stone-500">{inBook} pages</span>
				</p>
			{/if}
			{#if Object.keys(roles).length > 1}
				<div class="ml-auto *:justify-end"><PrintChips {roles} activeRole={filter?.kind === 'role' ? filter.role : null} {onrole} /></div>
			{/if}
		</div>
	{/if}

	{@render children()}

	{#if shownPages.length}
		<BookPages pages={shownPages} {books} {selected} {href} {onselect} {thumbs} {icons} />
	{:else}
		<p class="rounded border border-dashed border-stone-700 p-4 text-sm text-stone-500">No pages match. Clear the filter or search to see them all.</p>
	{/if}
</section>
