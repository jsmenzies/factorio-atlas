<script lang="ts">
	import BlueprintIcons from '#lib/components/BlueprintIcons.svelte';
	import RichText from '#lib/components/RichText.svelte';
	import { describeNode, pageTitle } from '#lib/describe.js';
	import { formatRate } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';
	import { plainClick } from '#lib/links.js';
	import { plainText } from '#lib/richtext.js';
	import type { NodeAnalysis } from '#lib/server/pipeline/analyze.js';

	/**
	 * A book's pages as a carousel under two rows of tabs: the books at its top level (Flat,
	 * Elevated, Stations…), then the sub-books inside the chosen one (Cardinal › Intersections…),
	 * each tab holding the pages directly in that book, in a row that scrolls sideways. A row with
	 * one tab is left out, so a book without sub-books has no tabs. Big books of simple pages (65
	 * balancers) get compact chips.
	 */
	let {
		pages,
		books,
		selected,
		href,
		onselect,
		icons
	}: {
		pages: NodeAnalysis[];
		books: NodeAnalysis[];
		selected: string;
		/** A page's URL: tiles are links, so search engines find every page and they open in new tabs. */
		href: (path: string) => string;
		onselect: (path: string) => void;
		icons: IconSet;
	} = $props();

	const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');
	const bookTitle = (path: string) => {
		const book = books.find((b) => b.path === path);
		return book ? pageTitle(book).text : 'Untitled';
	};

	interface Group {
		/** Path of the book the pages are directly in ('' for the print's own book). */
		parent: string;
		/** The top-level book it sits in ('' for pages at the top level). */
		top: string;
		pages: NodeAnalysis[];
		/** Its tab: the books from below the top-level one down to its own, as few as tell it apart. */
		label: string[];
		number: number | null;
	}
	interface Top {
		key: string;
		title: string;
		groups: Group[];
		count: number;
	}

	/** Names each group by the shortest tail of its book chain that no other group shares, numbering any still alike. */
	const label = (gs: { chain: string[] }[]) => {
		const depth = gs.map(() => 1);
		const name = (i: number) => gs[i].chain.slice(-depth[i]).map(plainText).join(' › ');
		for (let changed = true; changed; ) {
			changed = false;
			const counts = new Map<string, number>();
			gs.forEach((_, i) => counts.set(name(i), (counts.get(name(i)) ?? 0) + 1));
			gs.forEach((g, i) => {
				if (counts.get(name(i))! > 1 && depth[i] < g.chain.length) {
					depth[i]++;
					changed = true;
				}
			});
		}
		const totals = new Map<string, number>();
		gs.forEach((_, i) => totals.set(name(i), (totals.get(name(i)) ?? 0) + 1));
		const seen = new Map<string, number>();
		return gs.map((g, i) => {
			const n = (seen.get(name(i)) ?? 0) + 1;
			seen.set(name(i), n);
			return { label: g.chain.slice(-depth[i]), number: totals.get(name(i))! > 1 ? n : null };
		});
	};

	// One group per book that holds pages, in order of its first page (a book that comes back
	// after a sub-book stays one group), gathered under its top-level book.
	const tops = $derived.by(() => {
		const byParent = new Map<string, NodeAnalysis[]>();
		for (const n of pages) {
			const parent = parentOf(n.path);
			byParent.set(parent, [...(byParent.get(parent) ?? []), n]);
		}
		const byTop = new Map<string, { parent: string; pages: NodeAnalysis[]; chain: string[] }[]>();
		for (const [parent, ps] of byParent) {
			const top = parent.split('/')[0];
			const chain: string[] = [];
			for (let at = parent; at && at !== top; at = parentOf(at)) chain.unshift(bookTitle(at));
			byTop.set(top, [...(byTop.get(top) ?? []), { parent, pages: ps, chain }]);
		}
		const single = byTop.size === 1;
		return [...byTop].map(([key, gs]): Top => {
			const title = key ? bookTitle(key) : 'Top level';
			// Pages directly in the top-level book: named after it when it is the only top, else "Pages".
			const withChains = gs.map((g) => ({ ...g, chain: g.chain.length ? g.chain : [single ? title : 'Pages'] }));
			const names = label(withChains);
			const groups = withChains.map((g, i) => ({ parent: g.parent, top: key, pages: g.pages, ...names[i] }));
			return { key, title, groups, count: gs.reduce((n, g) => n + g.pages.length, 0) };
		});
	});
	const groups = $derived(tops.flatMap((t) => t.groups));

	// The tabs follow the selected page (stepping with ‹ › can cross into another book); a click on
	// a tab shows its pages without changing the selection, until the selection changes again.
	const selectedGroup = $derived(groups.find((g) => g.pages.some((n) => n.path === selected)) ?? groups[0]);
	const unpicked = (): string | null => {
		void selected;
		return null;
	};
	let pickedTop = $derived.by(unpicked);
	let pickedGroup = $derived.by(unpicked);
	const activeTop = $derived(tops.find((t) => t.key === (pickedTop ?? selectedGroup?.top)) ?? tops[0]);
	const active = $derived(
		activeTop?.groups.find((g) => g.parent === pickedGroup) ??
			activeTop?.groups.find((g) => g === selectedGroup) ??
			activeTop?.groups[0]
	);
	const pickTop = (key: string) => {
		pickedTop = key;
		pickedGroup = null;
	};

	const compact = $derived(pages.length > 24);
	const twoRows = $derived((active?.pages.length ?? 0) > (compact ? 6 : 4));

	let strip = $state<HTMLUListElement>();
	let atStart = $state(true);
	let atEnd = $state(true);
	const measure = () => {
		if (!strip) return;
		atStart = strip.scrollLeft <= 1;
		atEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
	};
	const scrollBy = (dir: number) => strip?.scrollBy({ left: dir * strip.clientWidth * 0.9, behavior: 'smooth' });
	// Bring the selected page into view when it or the tab changes.
	$effect(() => {
		void active;
		const el = strip?.querySelector<HTMLElement>('[aria-current="true"]');
		if (el && strip) {
			const left = el.offsetLeft - strip.offsetLeft;
			if (left < strip.scrollLeft || left + el.offsetWidth > strip.scrollLeft + strip.clientWidth)
				strip.scrollTo({ left: Math.max(0, left - 16), behavior: 'smooth' });
		} else strip?.scrollTo({ left: 0 });
		requestAnimationFrame(measure);
	});

	const rateOf = (n: NodeAnalysis) => n.claimedRate ?? n.estimatedRate;
</script>

<svelte:window onresize={measure} />

<div class="space-y-2">
	{#if tops.length > 1}
		<div role="tablist" aria-label="Books" class="flex flex-wrap gap-1 border-b border-stone-800">
			{#each tops as t (t.key)}
				{@const on = t === activeTop}
				<button
					role="tab"
					aria-selected={on}
					onclick={() => pickTop(t.key)}
					class="-mb-px rounded-t-md border border-b-0 px-3 py-1.5 text-sm whitespace-nowrap transition {on
						? 'border-stone-700 bg-stone-900 text-amber-300'
						: 'border-transparent text-stone-400 hover:bg-stone-900/60 hover:text-stone-200'}"
				>
					<RichText text={t.title} {icons} size={14} />
					<span class="ml-1 text-xs text-stone-500">{t.count}</span>
				</button>
			{/each}
		</div>
	{/if}
	{#if activeTop && activeTop.groups.length > 1}
		<div role="tablist" aria-label="Sub-books" class="flex flex-wrap gap-1">
			{#each activeTop.groups as g (g.parent)}
				{@const on = g === active}
				<button
					role="tab"
					aria-selected={on}
					onclick={() => (pickedGroup = g.parent)}
					class="rounded-full border px-2.5 py-0.5 text-xs whitespace-nowrap transition {on
						? 'border-amber-500/60 bg-amber-500/10 text-amber-200'
						: 'border-stone-800 text-stone-400 hover:border-stone-600 hover:text-stone-200'}"
				>
					{#each g.label.slice(0, -1) as b, i (i)}<span class="opacity-60"><RichText text={b} {icons} size={12} />&nbsp;›&nbsp;</span
						>{/each}<RichText text={g.label.at(-1) ?? ''} {icons} size={12} />{#if g.number}<span class="opacity-60">&nbsp;{g.number}</span>{/if}
					<span class="ml-1 opacity-60">{g.pages.length}</span>
				</button>
			{/each}
		</div>
	{/if}

	{#if active}
		<div class="relative">
			<ul
				bind:this={strip}
				onscroll={measure}
				role={groups.length > 1 ? 'tabpanel' : undefined}
				class="grid snap-x grid-flow-col gap-1.5 overflow-x-auto scroll-smooth pb-2 [scrollbar-width:thin] {compact
					? 'auto-cols-[8.5rem]'
					: 'auto-cols-[12rem]'} {twoRows ? 'grid-rows-2' : 'grid-rows-1'}"
			>
				{#each active.pages as n (n.path)}
					{@const t = pageTitle(n)}
					{@const rate = rateOf(n)}
					<li class="snap-start">
						<a
							href={href(n.path)}
							onclick={(e) => {
								if (!plainClick(e)) return;
								e.preventDefault();
								onselect(n.path);
							}}
							aria-current={n.path === selected ? 'true' : undefined}
							class="flex h-full w-full items-center gap-2 rounded-md border text-left transition {compact ? 'px-1.5 py-1' : 'p-1.5'} {n.path === selected
								? 'border-amber-500/70 bg-amber-500/10'
								: 'border-stone-800 bg-stone-900/60 hover:border-stone-600'}"
						>
							{#if n.icons.length}
								<BlueprintIcons {icons} signals={n.icons} size={compact ? 26 : 34} />
							{/if}
							<span class="min-w-0 flex-1">
								<span class="line-clamp-2 text-sm leading-tight {t.derived ? 'text-stone-400 italic' : 'text-stone-200'}"
									><RichText text={t.text} {icons} size={14} /></span
								>
								{#if !compact}
									<span class="block truncate text-xs {rate ? 'text-emerald-300' : 'text-stone-500'}">
										{rate ? `${n.claimedRate ? '' : '≈ '}${formatRate(rate)}` : describeNode(n)}
									</span>
								{/if}
							</span>
						</a>
					</li>
				{/each}
			</ul>
			{#if !atStart}
				<button
					onclick={() => scrollBy(-1)}
					aria-label="Scroll pages left"
					class="absolute top-[calc(50%-0.25rem)] left-0 grid size-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-stone-700 bg-stone-900/95 text-stone-200 shadow hover:border-amber-500/60 hover:text-amber-300"
					><svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
						><polyline points="15 18 9 12 15 6" /></svg
					></button
				>
			{/if}
			{#if !atEnd}
				<button
					onclick={() => scrollBy(1)}
					aria-label="Scroll pages right"
					class="absolute top-[calc(50%-0.25rem)] right-0 grid size-8 translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-stone-700 bg-stone-900/95 text-stone-200 shadow hover:border-amber-500/60 hover:text-amber-300"
					><svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
						><polyline points="9 18 15 12 9 6" /></svg
					></button
				>
			{/if}
		</div>
	{/if}
</div>
