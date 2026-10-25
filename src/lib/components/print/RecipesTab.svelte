<script lang="ts" module>
	/** What the game data says a recipe takes and makes (from the print page's load). */
	export interface RecipeInfo {
		section: string;
		time: number | null;
		ingredients: [string, number][];
		results: [string, number][];
	}
</script>

<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import Rate from '#lib/components/Rate.svelte';
	import { GROUP_ORDER } from '#lib/describe.js';
	import { signalName } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';
	import type { NodeAnalysis } from '#lib/server/pipeline/analyze.js';

	/**
	 * The recipes set in a print's machines, by crafting-menu section: each with what it takes and
	 * makes (from the game data), how many machines run it, and on how many pages (a book) or its
	 * nameplate rate (a single blueprint).
	 */
	let {
		recipes,
		info,
		pages,
		single,
		icons
	}: {
		/** Machines per recipe. */
		recipes: Record<string, number>;
		info: Record<string, RecipeInfo>;
		pages: NodeAnalysis[];
		single: NodeAnalysis | null;
		icons: IconSet;
	} = $props();

	let query = $state('');
	// Long sections show this many recipes until opened.
	const LIMIT = 10;
	let open = $state<Record<string, boolean>>({});
	const rateOf = (name: string) => {
		if (!single) return null;
		const key = Object.keys(single.rates).find((k) => k.slice(k.indexOf(':') + 1) === name);
		return key && single.rates[key] > 0 ? single.rates[key] : null;
	};
	const sections = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const by = new Map<string, { name: string; machines: number; pages: number; rate: number | null; info: RecipeInfo | undefined }[]>();
		for (const [name, machines] of Object.entries(recipes)) {
			const r = info[name];
			if (q && !signalName(name).toLowerCase().includes(q) && !r?.results.some(([x]) => signalName(x).toLowerCase().includes(q))) continue;
			const section = r?.section ?? 'Other';
			const main = r?.results[0]?.[0] ?? name;
			by.set(section, [
				...(by.get(section) ?? []),
				{ name, machines, pages: pages.filter((n) => name in n.recipes).length, rate: rateOf(main), info: r }
			]);
		}
		return [...by].map(([name, rows]) => ({ name, rows })).sort((x, y) => GROUP_ORDER.indexOf(x.name) - GROUP_ORDER.indexOf(y.name));
	});
	const machines = $derived(Object.values(recipes).reduce((s, n) => s + n, 0));
</script>

{#snippet amounts(list: [string, number][])}
	{#each list as [name, n] (name)}
		<span class="flex items-center gap-0.5" title="{n} {signalName(name)}">
			<Icon {icons} {name} label={signalName(name)} size={18} /><span class="text-xs text-stone-400">{+n.toFixed(2)}</span>
		</span>
	{/each}
{/snippet}

{#if !Object.keys(recipes).length}
	<p class="rounded border border-dashed border-stone-700 p-4 text-sm text-stone-400">
		No recipes set on this page. Furnaces pick their own, so smelting pages have none.
	</p>
{:else}
<div class="space-y-6">
	<div class="flex flex-wrap items-center gap-3">
		<label class="flex min-w-48 flex-1 items-center gap-2 rounded border border-stone-700 bg-stone-900 px-2 py-1 text-sm sm:max-w-xs">
			<span class="sr-only">Find a recipe</span>
			<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-stone-500"
				><circle cx="11" cy="11" r="7" /><line x1="16.5" y1="16.5" x2="21" y2="21" /></svg
			>
			<input bind:value={query} placeholder="Find a recipe or what it makes" class="min-w-0 flex-1 bg-transparent placeholder:text-stone-500 focus:outline-none" />
		</label>
		<p class="text-sm text-stone-400">
			{Object.keys(recipes).length} recipes set in {machines.toLocaleString()} machines{pages.length > 1 ? ` across ${pages.length} pages` : ''}
		</p>
	</div>

	{#each sections as s (s.name)}
		<section>
			<h3 class="border-b border-stone-800 pb-2 font-semibold text-stone-100">
				{s.name} <span class="text-sm font-normal text-stone-500">{s.rows.length}</span>
			</h3>
			<ul class="divide-y divide-stone-800/60 text-sm">
				{#each open[s.name] || query.trim() ? s.rows : s.rows.slice(0, LIMIT) as r (r.name)}
					<li class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
						<Icon {icons} kind="recipe" name={r.name} label={signalName(r.name)} size={28} />
						<span class="min-w-0 flex-1 truncate text-stone-200">{signalName(r.name)}</span>
						{#if r.info?.results.length}
							<span class="hidden items-center gap-1.5 md:flex" aria-label="Takes and makes">
								{@render amounts(r.info.ingredients)}
								<span class="text-stone-600" aria-hidden="true">→</span>
								{@render amounts(r.info.results)}
								{#if r.info.time !== null}<span class="text-xs text-stone-500" title="Crafting time at speed 1">{r.info.time} s</span>{/if}
							</span>
						{/if}
						<span class="w-24 shrink-0 text-right text-stone-300 tabular-nums" title="Machines set to this recipe">
							{r.machines.toLocaleString()} machine{r.machines === 1 ? '' : 's'}
						</span>
						{#if single}
							<span class="min-w-20 shrink-0 text-right whitespace-nowrap tabular-nums {r.rate ? 'text-stone-100' : 'text-stone-600'}" title="Its main product, with every machine crafting at full speed">
								{#if r.rate}≈ <Rate value={r.rate} />{:else}—{/if}
							</span>
						{:else}
							<span class="w-20 shrink-0 text-right text-stone-500">{r.pages} page{r.pages === 1 ? '' : 's'}</span>
						{/if}
					</li>
				{/each}
			</ul>
			{#if s.rows.length > LIMIT && !query.trim()}
				<button type="button" class="mt-1 text-xs text-stone-400 hover:text-amber-300" onclick={() => (open[s.name] = !open[s.name])}>
					{open[s.name] ? 'Show fewer' : `Show all ${s.rows.length}`}
				</button>
			{/if}
		</section>
	{:else}
		<p class="rounded border border-dashed border-stone-700 p-4 text-sm text-stone-500">No recipes match.</p>
	{/each}
</div>
{/if}
