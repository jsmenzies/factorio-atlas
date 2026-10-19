<script lang="ts">
	import BlueprintIcons from '#lib/components/BlueprintIcons.svelte';
	import RichText from '#lib/components/RichText.svelte';
	import { describeNode, pageTitle } from '#lib/describe.js';
	import { formatRate } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';
	import type { NodeAnalysis } from '#lib/server/pipeline/analyze.js';

	/**
	 * A book's pages as a grid of cards, like the game's book view. Big books of simple pages
	 * (65 balancers) get compact chips; nested books get a heading per sub-book.
	 */
	let {
		pages,
		books,
		selected,
		onselect,
		icons
	}: { pages: NodeAnalysis[]; books: NodeAnalysis[]; selected: string; onselect: (path: string) => void; icons: IconSet } = $props();

	const compact = $derived(pages.length > 24);
	const limit = $derived(compact ? 30 : 12);
	let expanded = $state(false);
	const selectedIndex = $derived(pages.findIndex((n) => n.path === selected));
	// Never hide the selected page behind "show all".
	const shown = $derived(expanded || selectedIndex >= limit ? pages : pages.slice(0, limit));

	const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');
	const groups = $derived.by(() => {
		const out: { parent: string; title: string | null; pages: NodeAnalysis[] }[] = [];
		for (const n of shown) {
			const parent = parentOf(n.path);
			let g = out.at(-1);
			if (!g || g.parent !== parent) {
				const book = books.find((b) => b.path === parent);
				g = { parent, title: parent && book ? pageTitle(book).text : null, pages: [] };
				out.push(g);
			}
			g.pages.push(n);
		}
		return out;
	});

	const rateOf = (n: NodeAnalysis) => n.claimedRate ?? n.estimatedRate;
</script>

<div class="space-y-3">
	{#each groups as g (g.parent)}
		<div>
			{#if g.title}<h3 class="mb-1.5 text-xs font-semibold tracking-wide text-stone-400 uppercase"><RichText text={g.title} {icons} size={14} /></h3>{/if}
			<ul class="grid gap-1.5 {compact ? 'grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))]' : 'grid-cols-[repeat(auto-fill,minmax(12rem,1fr))]'}">
				{#each g.pages as n (n.path)}
					{@const t = pageTitle(n)}
					{@const rate = rateOf(n)}
					<li>
						<button
							onclick={() => onselect(n.path)}
							aria-current={n.path === selected ? 'true' : undefined}
							class="flex w-full items-center gap-2 rounded-md border text-left transition {compact ? 'px-1.5 py-1' : 'p-1.5'} {n.path === selected
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
						</button>
					</li>
				{/each}
			</ul>
		</div>
	{/each}
	{#if shown.length < pages.length}
		<button class="text-sm text-amber-400 hover:text-amber-300" onclick={() => (expanded = true)}>Show all {pages.length} pages</button>
	{:else if expanded}
		<button class="text-sm text-stone-400 hover:text-amber-300" onclick={() => (expanded = false)}>Show fewer</button>
	{/if}
</div>
