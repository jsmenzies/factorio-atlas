<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Icon from '#lib/components/Icon.svelte';
	import SearchBox from '#lib/components/SearchBox.svelte';
	import ResultCard from '#lib/components/search/ResultCard.svelte';
	import RenderToggle from '#lib/components/search/RenderToggle.svelte';
	import SearchFacets from '#lib/components/search/SearchFacets.svelte';
	import { pickParam, type PickerItem } from '#lib/picker.js';
	import { signalName } from '#lib/format.js';
	import { parseTag } from '#lib/tags.js';
	import { MULTI_FILTERS } from '#lib/filters.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const multi = new Set<string>(MULTI_FILTERS);
	/**
	 * Link to the current search with one filter value toggled. Filters that take several values
	 * (makes, uses, version, …) add it to the ones already set, so each click narrows the results;
	 * the rest (Space Age, sort, …) hold one value and switch to it.
	 */
	const toggle = (key: string, value: string) => {
		const u = new URL(page.url.href);
		const had = u.searchParams.getAll(key);
		u.searchParams.delete(key);
		if (multi.has(key)) for (const v of had.includes(value) ? had.filter((v) => v !== value) : [...had, value]) u.searchParams.append(key, v);
		else if (!had.includes(value)) u.searchParams.set(key, value);
		return `${u.pathname}${u.search}`;
	};
	const active = (key: string, value: string) => page.url.searchParams.getAll(key).includes(value);

	/**
	 * Picking an item adds a filter to prints that make it (a building: that use it), next to the
	 * filters already set; the typed text only found it, so drop it.
	 */
	const pickItem = (item: PickerItem) => {
		const u = new URL(page.url.href);
		const key = pickParam(item);
		if (!u.searchParams.getAll(key).includes(item.signal)) u.searchParams.append(key, item.signal);
		u.searchParams.delete('q');
		// Best match needs text to match; without it the default sort applies.
		if (u.searchParams.get('sort') === 'relevance') u.searchParams.delete('sort');
		goto(`${u.pathname}${u.search}`);
	};
	/** "Best match" only means something when there is text to match. */
	const sortOptions = $derived(
		[
			...(data.params.q ? [['relevance', 'Best match']] : []),
			['favorites', 'Most favourited'],
			['recent', 'Recently updated']
		] as [string, string][]
	);
	const itemLabel = (signal: string) => data.picker.find((p) => p.signal === signal)?.label ?? signalName(signal);

	/** Every active filter value as a removable tag; clicking one clears just that value. */
	type Chip = { key: string; value: string; label: string; icon?: string };
	const chips = $derived<Chip[]>([
		...data.params.makes.map((v) => ({ key: 'makes', value: v, label: itemLabel(v), icon: v })),
		...data.params.takes.map((v) => ({ key: 'takes', value: v, label: `Takes ${itemLabel(v)}`, icon: v })),
		...data.params.uses.map((v) => ({ key: 'uses', value: v, label: `Uses ${itemLabel(v)}`, icon: v })),
		...data.params.recipe.map((v) => ({ key: 'recipe', value: v, label: `Recipe ${signalName(v)}`, icon: `recipe:${v}` })),
		...data.params.module.map((v) => ({ key: 'module', value: v, label: `Module ${signalName(v)}`, icon: `item:${v}` })),
		...data.params.version.map((v) => ({ key: 'version', value: v, label: `Factorio ${v}` })),
		...data.params.tag.map((v) => ({ key: 'tag', value: v, label: parseTag(v).label })),
		...(data.params.spaceAge
			? [{ key: 'spaceAge', value: data.params.spaceAge, label: data.params.spaceAge === 'yes' ? 'Space Age' : 'No Space Age needed' }]
			: []),
		...(data.params.circuits ? [{ key: 'circuits', value: '1', label: 'Uses circuits' }] : []),
		...(data.params.trains ? [{ key: 'trains', value: '1', label: 'Uses trains' }] : []),
		...(data.params.render ? [{ key: 'render', value: '1', label: 'Has a render' }] : [])
	]);
</script>

<!-- Enter submits (the input is type="search"); the active filters and sort ride along as hidden inputs. -->
<form method="GET" role="search" class="mb-6 flex gap-2">
	{#key data.params.q}
		<SearchBox value={data.params.q} items={data.picker} icons={data.icons} onpick={pickItem} />
	{/key}
	<RenderToggle on={data.params.render} href={toggle('render', '1')} />
	{#each [...MULTI_FILTERS, 'spaceAge', 'circuits', 'trains', 'render', 'sort'] as key (key)}
		{#each page.url.searchParams.getAll(key).filter(Boolean) as value, i (i)}
			<input type="hidden" name={key} {value} />
		{/each}
	{/each}
</form>

<div class="grid gap-6 md:grid-cols-[16rem_1fr]">
	<SearchFacets
		makes={data.facets.makes}
		uses={data.facets.uses}
		versions={data.facets.versions}
		makesLabel={signalName}
		usesLabel={itemLabel}
		{toggle}
		{active}
		icons={data.icons}
	/>

	<section>
		{#if chips.length}
			<div class="mb-3 flex flex-wrap gap-2 text-sm">
				{#each chips as c (`${c.key}=${c.value}`)}
					<a
						href={toggle(c.key, c.value)}
						class="flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-500/10 py-0.5 pr-3 text-amber-200 hover:bg-amber-500/20 {c.icon
							? 'pl-1'
							: 'pl-3'}"
						aria-label="Remove filter: {c.label}"
					>
						{#if c.icon}<Icon icons={data.icons} signal={c.icon} label="" size={20} />{/if}
						{c.label} <span class="text-amber-400">×</span>
					</a>
				{/each}
			</div>
		{/if}
		<div class="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm text-stone-400">
			<p>{data.results.length} print{data.results.length === 1 ? '' : 's'}</p>
			<!-- A GET form, so it works without JS; with JS, changing the select submits it and keeps focus and scroll. -->
			<form method="GET" data-sveltekit-reset="false">
				{#each [...page.url.searchParams].filter(([k]) => k !== 'sort') as [k, v], i (i)}
					<input type="hidden" name={k} value={v} />
				{/each}
				<label class="relative flex items-center gap-1">
					<span class="text-stone-500">Sort:</span>
					<select
						name="sort"
						value={data.params.sort}
						class="field-sizing-content cursor-pointer appearance-none rounded bg-transparent py-0.5 pr-5 pl-1 text-stone-200 hover:bg-stone-800 focus:bg-stone-800 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500"
						onchange={(e) => e.currentTarget.form?.requestSubmit()}
					>
						{#each sortOptions as [value, label] (value)}
							<option {value} class="bg-stone-900">{label}</option>
						{/each}
					</select>
					<svg aria-hidden="true" viewBox="0 0 12 12" class="pointer-events-none absolute right-1 size-3 fill-current text-stone-400">
						<path d="M2.5 4.5 6 8l3.5-3.5z" />
					</svg>
				</label>
				<noscript><button class="ml-1 rounded bg-stone-800 px-2 py-0.5 text-stone-200">Apply</button></noscript>
			</form>
		</div>
		{#if data.results.length === 0}
			<p class="rounded border border-dashed border-stone-700 p-8 text-center text-stone-500">
				{#if chips.length || data.params.q}
					No prints match. Remove a filter above to widen the search.
				{:else}
					No prints yet. Run <code class="text-amber-300">bun run ingest --top 5</code> to pull some in.
				{/if}
			</p>
		{/if}
		<ul class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
			{#each data.results as p (p.id)}
				<ResultCard print={p} {toggle} {active} renderOnly={data.params.render} icons={data.icons} />
			{/each}
		</ul>
	</section>
</div>
