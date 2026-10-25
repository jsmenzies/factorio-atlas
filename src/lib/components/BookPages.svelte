<script lang="ts">
	import { uniqueTails } from '#lib/book-groups.js';
	import BlueprintIcons from '#lib/components/BlueprintIcons.svelte';
	import Rate from '#lib/components/Rate.svelte';
	import RichText from '#lib/components/RichText.svelte';
	import { describeNode, pageTitle } from '#lib/describe.js';
	import { signalName } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';
	import { plainClick } from '#lib/links.js';
	import { plainText } from '#lib/richtext.js';
	import type { NodeAnalysis } from '#lib/server/pipeline/analyze.js';
	import type { PageThumb } from '#lib/viewer/thumbs.js';

	/**
	 * A book's pages as a grid of cards, one book at a time: with sub-books, a row of chips above the
	 * grid, one per book that holds pages, named by the shortest tail of its chain that tells it
	 * apart. Each card is the page's render thumbnail (its
	 * icons when it has none, or it fails to load), its name, and its rate or what it does. Two rows
	 * show until opened, all when the selected page is further in.
	 */
	let {
		pages,
		books,
		selected,
		href,
		onselect,
		thumbs = {},
		icons
	}: {
		pages: NodeAnalysis[];
		books: NodeAnalysis[];
		selected: string;
		/** A page's URL: cards are links, so search engines find every page and they open in new tabs. */
		href: (path: string) => string;
		onselect: (path: string) => void;
		/** Page thumbnails by book path. */
		thumbs?: Record<string, PageThumb>;
		icons: IconSet;
	} = $props();

	const LIMIT = 8;
	const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');
	const bookTitle = (path: string) => {
		const book = books.find((b) => b.path === path);
		return book ? pageTitle(book).text : 'Untitled';
	};
	/** The books from the top level down to `path`'s own. */
	const chainOf = (path: string): string[] => (path ? [...chainOf(parentOf(path)), bookTitle(path)] : []);

	interface Group {
		/** Path of the book the pages are directly in ('' for the print's own book). */
		parent: string;
		pages: NodeAnalysis[];
		/** Its chip: as few of its books (from the bottom) as tell it apart, numbered when still alike. */
		label: string[];
		number: number | null;
	}

	// One group per book that holds pages, in order of its first page (a book that comes back after
	// a sub-book stays one group).
	const groups = $derived.by((): Group[] => {
		const byParent = new Map<string, NodeAnalysis[]>();
		for (const n of pages) {
			const parent = parentOf(n.path);
			byParent.set(parent, [...(byParent.get(parent) ?? []), n]);
		}
		const gs = [...byParent].map(([parent, ps]) => ({ parent, pages: ps, chain: parent ? chainOf(parent) : ['Pages'] }));
		const names = uniqueTails(
			gs.map((g) => g.chain),
			plainText
		);
		return gs.map((g, i) => ({ parent: g.parent, pages: g.pages, label: g.chain.slice(-names[i].depth), number: names[i].number }));
	});

	// The chips follow the selected page (‹ › can cross into another book); a click on a chip shows
	// its pages without changing the selection, until the selection changes again. Opening the grid
	// lasts as long, too.
	const selectedGroup = $derived(groups.find((g) => g.pages.some((n) => n.path === selected)) ?? groups[0]);
	const unpicked = <T,>(none: T) => {
		void selected;
		return none;
	};
	let picked = $derived.by(() => unpicked<string | null>(null));
	let open = $derived.by(() => unpicked(false));
	const active = $derived(groups.find((g) => g.parent === picked) ?? selectedGroup);
	const pick = (parent: string) => {
		picked = parent;
		open = false;
	};
	const selectedAt = $derived(active?.pages.findIndex((n) => n.path === selected) ?? -1);
	// Cards past the first two rows are hidden, not left out: their links let crawlers find every page.
	const showAll = $derived(open || selectedAt >= LIMIT);

	/** Pages whose thumbnail failed to load, which show their icons instead. */
	let failed = $state<string[]>([]);
	const rateOf = (n: NodeAnalysis) => n.claimedRate ?? n.estimatedRate;
	/** The card's second line: its rate, else what it makes, else what it is. */
	const note = (n: NodeAnalysis) => {
		const rate = rateOf(n);
		if (rate) return { text: n.claimedRate ? '' : '≈ ', rate };
		if (n.outputs.length) return { text: n.outputs.slice(0, 3).map((s) => signalName(s).toLowerCase()).join(' · '), rate: null };
		return { text: describeNode(n), rate: null };
	};
</script>

<div class="space-y-3">
	{#if groups.length > 1 && active}
		<div role="tablist" aria-label="Books" class="flex flex-wrap gap-2">
			{#each groups as g (g.parent)}
				{@const on = g === active}
				<button
					type="button"
					role="tab"
					aria-selected={on}
					onclick={() => pick(g.parent)}
					class="rounded-full border px-3.5 py-1.5 text-sm transition {on
						? 'border-amber-500/70 bg-amber-500/10 text-amber-200'
						: 'border-stone-700 text-stone-300 hover:border-stone-500 hover:text-stone-100'}"
				>
					{#each g.label.slice(0, -1) as b, i (i)}<span class="opacity-60"><RichText text={b} {icons} size={14} />&nbsp;›&nbsp;</span
						>{/each}<RichText text={g.label.at(-1) ?? ''} {icons} size={14} />{#if g.number}<span class="opacity-60">&nbsp;{g.number}</span>{/if}
					<span class="ml-1 font-mono text-xs text-stone-500">{g.pages.length}</span>
				</button>
			{/each}
		</div>
	{/if}

	{#if active}
		<ul role={groups.length > 1 ? 'tabpanel' : undefined} class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
			{#each active.pages as n, i (n.path)}
				{@const t = pageTitle(n)}
				{@const here = n.path === selected}
				{@const thumb = failed.includes(n.path) ? undefined : thumbs[n.path]}
				{@const line = note(n)}
				<li class={showAll || i < LIMIT ? '' : 'hidden'}>
					<a
						href={href(n.path)}
						onclick={(e) => {
							if (!plainClick(e)) return;
							e.preventDefault();
							onselect(n.path);
						}}
						aria-current={here ? 'true' : undefined}
						class="group flex h-full flex-col overflow-hidden rounded-lg border transition {here
							? 'border-amber-500 ring-1 ring-amber-500/50'
							: 'border-stone-800 hover:border-stone-600'}"
					>
						<span class="relative grid aspect-video place-items-center bg-stone-950">
							{#if thumb}
								<img
									srcset={thumb.srcset}
									sizes="(min-width: 1280px) 14rem, (min-width: 640px) 33vw, 50vw"
									alt=""
									loading="lazy"
									width={thumb.w}
									height={thumb.h}
									onerror={() => (failed = [...failed, n.path])}
									class="absolute inset-0 size-full object-contain p-1.5"
								/>
							{:else if n.icons.length}
								<BlueprintIcons {icons} signals={n.icons} size={44} />
							{/if}
						</span>
						<span class="min-w-0 flex-1 bg-stone-900/70 px-3 py-2.5 group-hover:bg-stone-900">
							<span class="block truncate font-medium {t.derived ? 'text-stone-300 italic' : 'text-stone-100'}"><RichText text={t.text} {icons} size={16} /></span>
							<span class="mt-0.5 block truncate font-mono text-xs {line.rate ? 'text-stone-100' : 'text-stone-400'}">{#if line.rate}{line.text}<Rate value={line.rate} />{:else}<RichText text={line.text} {icons} size={14} />{/if}</span
							>
						</span>
					</a>
				</li>
			{/each}
		</ul>
		{#if active.pages.length > LIMIT && selectedAt < LIMIT}
			<button type="button" class="text-sm text-stone-400 hover:text-amber-300" onclick={() => (open = !open)}>
				{open ? 'Show fewer' : `Show all ${active.pages.length} pages`}
			</button>
		{/if}
	{/if}
</div>
