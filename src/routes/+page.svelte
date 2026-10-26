<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import { dev } from '$app/env';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Icon from '#lib/components/Icon.svelte';
	import PageMeta from '#lib/components/PageMeta.svelte';
	import RenderIcon from '#lib/components/RenderIcon.svelte';
	import SearchBox from '#lib/components/SearchBox.svelte';
	import ResultCard from '#lib/components/search/ResultCard.svelte';
	import QualityChip from '#lib/components/search/QualityChip.svelte';
	import RenderToggle from '#lib/components/search/RenderToggle.svelte';
	import SearchFacets from '#lib/components/search/SearchFacets.svelte';
	import { pickParam, type PickerItem } from '#lib/picker.js';
	import { signalName } from '#lib/format.js';
	import { parseTag } from '#lib/tags.js';
	import { MULTI_FILTERS } from '#lib/filters.js';
	import { QUALITY_WORDS, splitQuality, takesQuality, withQualityValue, type QualityLevel } from '#lib/quality.js';
	import { landingMeta, landingPath, searchPage, searchRel } from '#lib/search-seo.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const multi = new Set<string>(MULTI_FILTERS);
	/** Whether two values of a filter are the same filter: makes, uses and module values are, at any quality. */
	const same = (key: string, a: string, b: string) => (takesQuality(key) ? splitQuality(a).base === splitQuality(b).base : a === b);
	/**
	 * Link to the current search with one filter value toggled. Filters that take several values
	 * (makes, uses, version, …) add it to the ones already set, so each click narrows the results;
	 * the rest (Space Age, sort, …) hold one value and switch to it. Either way the results change,
	 * so it goes back to their first page. An item set at a quality toggles off from its plain value.
	 */
	const toggle = (key: string, value: string) => {
		const u = new URL(page.url.href);
		u.searchParams.delete('p');
		const had = u.searchParams.getAll(key);
		u.searchParams.delete(key);
		const has = had.some((v) => same(key, v, value));
		if (multi.has(key)) for (const v of has ? had.filter((v) => !same(key, v, value)) : [...had, value]) u.searchParams.append(key, v);
		else if (!has) u.searchParams.set(key, value);
		return `${u.pathname}${u.search}`;
	};
	const active = (key: string, value: string) => page.url.searchParams.getAll(key).some((v) => same(key, v, value));
	/** A quality chip's counts in this search (routes/quality-levels), fetched when its choice opens. */
	const levelsUrl = (key: string, value: string) => {
		const u = new URLSearchParams(page.url.search);
		u.delete('p');
		u.set('filter', key);
		u.set('value', value);
		return `/quality-levels?${u}`;
	};
	/** Link to the current search with one makes/uses/module value at another quality (null: any), in its place. */
	const atQuality = (key: string, value: string, quality: QualityLevel | null) => {
		const u = new URL(page.url.href);
		u.searchParams.delete('p');
		const had = u.searchParams.getAll(key);
		u.searchParams.delete(key);
		for (const v of had) u.searchParams.append(key, v === value ? withQualityValue(splitQuality(v).base, quality) : v);
		return `${u.pathname}${u.search}`;
	};

	/**
	 * Picking an item adds a filter to prints that make it (a building: that use it), next to the
	 * filters already set, at the quality picked in the menu (fluids have none); the typed text only
	 * found it, so drop it. Picking an item already set changes its quality only when one was picked.
	 */
	const pickItem = (item: PickerItem, quality: QualityLevel | null) => {
		const u = new URL(page.url.href);
		const key = pickParam(item);
		const value = withQualityValue(item.signal, item.signal.startsWith('fluid:') ? null : quality);
		const had = u.searchParams.getAll(key);
		const existing = had.find((v) => same(key, v, value));
		if (existing === undefined) u.searchParams.append(key, value);
		else if (quality) {
			u.searchParams.delete(key);
			for (const v of had) u.searchParams.append(key, v === existing ? value : v);
		}
		u.searchParams.delete('q');
		u.searchParams.delete('p');
		// Best match needs text to match; without it the default sort applies.
		if (u.searchParams.get('sort') === 'relevance') u.searchParams.delete('sort');
		goto(`${u.pathname}${u.search}`);
	};
	/** "Best match" only means something when there is text to match. */
	const sortOptions = $derived(
		[
			...(data.params.q ? [['relevance', 'Best match']] : []),
			['favorites', 'Most favourited'],
			['popular', 'Popular this month'],
			['recent', 'Recently updated']
		] as [string, string][]
	);
	/** The current search on results page `n` (page 1 has no `p`). */
	const pageHref = (n: number) => {
		const u = new URL(page.url.href);
		if (n > 1) u.searchParams.set('p', String(n));
		else u.searchParams.delete('p');
		return `${u.pathname}${u.search}`;
	};
	const pager = $derived({
		prev: data.params.page > 1 ? pageHref(data.params.page - 1) : undefined,
		next: data.params.page < data.pages ? pageHref(data.params.page + 1) : undefined,
		// Past the last page that has results (`?p=` beyond them): offer the first page instead.
		beyond: data.results.length === 0 && data.total > 0
	});
	const plural = (n: number) => `${n.toLocaleString('en')} print${n === 1 ? '' : 's'}`;

	/**
	 * Phone widths: the filters sit in a drawer behind a button, so results come first. It stays open
	 * while filters are picked (each pick reloads the counts) until "Show N prints" or ×.
	 */
	let filtersOpen = $state(false);
	$effect(() => {
		document.documentElement.classList.toggle('max-md:overflow-hidden', filtersOpen);
	});
	const itemLabel = (signal: string) => data.picker.find((p) => p.signal === signal)?.label ?? signalName(signal);

	/**
	 * Dev-only trial of opening a quality chip's levels on hover: `?qhover=1` turns it on for the tab
	 * (sessionStorage, since links and the search form drop the parameter), `?qhover=0` off.
	 */
	let qhover = $state(false);
	$effect(() => {
		if (!dev) return;
		const asked = page.url.searchParams.get('qhover');
		try {
			if (asked !== null) sessionStorage.setItem('atlas.qhover', asked);
			qhover = sessionStorage.getItem('atlas.qhover') === '1';
		} catch {
			qhover = asked === '1';
		}
	});

	/**
	 * Every active filter value as a removable tag; clicking one clears just that value. Item filters
	 * and the render filter show only their icon or the cube (the label is the tooltip and accessible
	 * name); the rest keep their words.
	 */
	type Chip = { key: string; value: string; label: string; icon?: string; cube?: boolean; quality?: { base: string; level: QualityLevel | null; words: string } };
	/** A makes, uses or module chip: its quality goes in its label, and it gets a quality choice (QualityChip). */
	const qualityChip = (key: string, value: string, words: (base: string) => string, icon: (base: string) => string): Chip => {
		const { base, quality } = splitQuality(value);
		const label = `${words(base)}${quality ? `, ${QUALITY_WORDS[quality].long.toLowerCase()}` : ''}`;
		return { key, value, label, icon: icon(base), quality: { base, level: quality, words: words(base) } };
	};
	const chips = $derived<Chip[]>([
		...data.params.makes.map((v) => qualityChip('makes', v, itemLabel, (b) => b)),
		...data.params.takes.map((v) => ({ key: 'takes', value: v, label: `Takes ${itemLabel(v)}`, icon: v })),
		...data.params.uses.map((v) => qualityChip('uses', v, (b) => `Uses ${itemLabel(b)}`, (b) => b)),
		...data.params.recipe.map((v) => ({ key: 'recipe', value: v, label: `Recipe ${signalName(v)}`, icon: `recipe:${v}` })),
		...data.params.module.map((v) => qualityChip('module', v, (b) => `Module ${signalName(b)}`, (b) => `item:${b}`)),
		...data.params.quality.map((v) => ({ key: 'quality', value: v, label: `Has ${v} quality`, icon: `quality:${v}` })),
		...data.params.version.map((v) => ({ key: 'version', value: v, label: `Factorio ${v}` })),
		...data.params.tag.map((v) => ({ key: 'tag', value: v, label: parseTag(v).label })),
		...(data.params.author ? [{ key: 'author', value: data.params.author, label: `By ${data.authorName ?? 'this author'}` }] : []),
		...(data.params.spaceAge
			? [{ key: 'spaceAge', value: data.params.spaceAge, label: data.params.spaceAge === 'yes' ? 'Space Age' : 'No Space Age needed' }]
			: []),
		...(data.params.circuits ? [{ key: 'circuits', value: '1', label: 'Uses circuits' }] : []),
		...(data.params.trains ? [{ key: 'trains', value: '1', label: 'Uses trains' }] : []),
		...(data.params.render ? [{ key: 'render', value: '1', label: 'Has a render', cube: true }] : [])
	]);

	/**
	 * For search engines (lib/search-seo.ts): the home page and landing pages for one known item or
	 * building with results are indexed under one canonical URL; landing pages have a visible heading,
	 * the home page a heading only screen readers see. Every other search is noindex, with the same
	 * hidden heading. Results pages past the first are
	 * noindex too, titled after the search they page through.
	 */
	const seo = $derived.by((): { meta: ComponentProps<typeof PageMeta>; heading: string; style: 'title' | 'hidden'; home?: boolean } => {
		const n = data.params.page;
		const unpaged = new URLSearchParams(page.url.search);
		unpaged.delete('p');
		const kind = searchPage(unpaged);
		if (kind?.kind === 'home' && n > 1) {
			return {
				meta: { title: `Factorio blueprints, page ${n} · Blueprint Atlas`, description: `Factorio blueprints, most favourited first: page ${n}.`, noindex: true },
				heading: `Factorio blueprints, page ${n}`,
				style: 'hidden'
			};
		}
		if (kind?.kind === 'home') {
			return {
				meta: {
					title: 'Blueprint Atlas · Search Factorio blueprints with high-res renders',
					description:
						'Search Factorio blueprints by what they make, the buildings they use, game version and Space Age, and explore them in zoomable in-game renders.',
					canonical: '/'
				},
				heading: 'Search Factorio blueprints',
				style: 'hidden',
				home: true
			};
		}
		const item = kind ? data.picker.find((p) => p.signal === kind.value) : undefined;
		if (kind && item && item.n > 0 && n > 1) {
			const meta = landingMeta(kind, item.label, item.n);
			return {
				meta: { ...meta, title: meta.title.replace(' · ', `, page ${n} · `), noindex: true },
				heading: `${item.label} blueprints`,
				style: 'title'
			};
		}
		if (kind && item && item.n > 0) {
			return { meta: { ...landingMeta(kind, item.label, item.n), canonical: landingPath(kind) }, heading: `${item.label} blueprints`, style: 'title' };
		}
		const what = [...(data.params.q ? [`“${data.params.q}”`] : []), ...chips.map((c) => c.label)].join(', ');
		const paged = n > 1 ? `, page ${n}` : '';
		return {
			meta: { title: `${what || 'Search'}${paged} · Blueprint Atlas`, description: `Factorio blueprints: ${what || 'search'}${paged}.`, noindex: true },
			heading: 'Search results',
			style: 'hidden'
		};
	});

	const websiteLd = $derived(
		`<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'Blueprint Atlas', url: `${page.url.origin}/` })}</` + 'script>'
	);
</script>

<PageMeta {...seo.meta} />

<!-- The site's name for search results (Google's site names read WebSite data on the home page). Without it Google
     takes the parent domain's name. A data block, so the CSP doesn't apply to it. -->
<svelte:head>
	{#if seo.home}
		{@html websiteLd}
	{/if}
</svelte:head>

<!-- A landing page's title, or (the home page and other searches) a heading for screen readers only. -->
<h1 class={{ title: 'mb-3 text-xl font-semibold text-stone-100', hidden: 'sr-only' }[seo.style]}>
	{seo.heading}
</h1>

<!-- Enter submits (the input is type="search"); the active filters and sort ride along as hidden inputs. -->
<!-- One bar with one outline: the search box, and the render switch inside its right end. -->
<form
	method="GET"
	role="search"
	class="mb-6 flex items-center gap-2 rounded border border-stone-700 bg-stone-900 pr-1.5 focus-within:border-amber-500"
>
	{#key data.params.q}
		<SearchBox value={data.params.q} items={data.picker} icons={data.icons} onpick={pickItem} />
	{/key}
	<RenderToggle on={data.params.render} href={toggle('render', '1')} />
	{#each [...MULTI_FILTERS, 'author', 'spaceAge', 'circuits', 'trains', 'render', 'sort'] as key (key)}
		{#each page.url.searchParams.getAll(key).filter(Boolean) as value, i (i)}
			<input type="hidden" name={key} {value} />
		{/each}
	{/each}
</form>

<svelte:window onkeydown={(e) => e.key === 'Escape' && (filtersOpen = false)} />

<div class="grid gap-6 md:grid-cols-[16rem_1fr]">
	<!-- From md up the sidebar; below it a drawer. Closed, it is hidden, not removed, so its links stay in the page. -->
	{#if filtersOpen}
		<button type="button" class="fixed inset-0 z-40 bg-black/60 md:hidden" aria-label="Close filters" onclick={() => (filtersOpen = false)}></button>
	{/if}
	<div
		id="filters"
		class="max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:flex max-md:w-80 max-md:max-w-[85vw] max-md:flex-col max-md:bg-stone-900 max-md:shadow-xl max-md:transition-[translate,visibility] {filtersOpen
			? ''
			: 'max-md:invisible max-md:-translate-x-full'}"
	>
		<div class="flex items-center justify-between border-b border-stone-800 px-4 py-3 md:hidden">
			<h2 class="font-semibold text-stone-100">Filters</h2>
			<button type="button" class="rounded px-2 text-xl leading-none text-stone-400 hover:bg-stone-800" aria-label="Close filters" onclick={() => (filtersOpen = false)}
				>×</button
			>
		</div>
		<div class="max-md:flex-1 max-md:overflow-y-auto max-md:overscroll-contain max-md:p-4">
			<SearchFacets
				makes={data.facets.makes}
				uses={data.facets.uses}
				modules={data.facets.modules}
				qualities={data.facets.qualities}
				versions={data.facets.versions}
				makesLabel={signalName}
				usesLabel={itemLabel}
				{toggle}
				{active}
				icons={data.icons}
			/>
		</div>
		<div class="border-t border-stone-800 p-3 md:hidden">
			<button type="button" class="w-full rounded bg-amber-500 px-3 py-2 font-medium text-stone-950 hover:bg-amber-400" onclick={() => (filtersOpen = false)}>
				Show {plural(data.total)}
			</button>
		</div>
	</div>

	<section>
		{#if chips.length}
			<div class="mb-3 flex flex-wrap gap-2 text-sm">
				{#each chips as c (`${c.key}=${c.value}`)}
					{@const href = toggle(c.key, c.value)}
					{#if c.quality && c.icon}
						{@const q = c.quality}
						<QualityChip
							label={q.words}
							icon={c.icon}
							quality={q.level}
							countsUrl={levelsUrl(c.key, c.value)}
							hrefFor={(level) => atQuality(c.key, c.value, level)}
							removeHref={href}
							icons={data.icons}
							hover={qhover}
						/>
					{:else}
						<a
							{href}
							rel={searchRel(href)}
							class="flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 py-0.5 pr-2.5 text-amber-200 hover:bg-amber-500/20 {c.icon
								? 'pl-1'
								: c.cube
									? 'pl-2'
									: 'pl-2.5'}"
							aria-label="Remove filter: {c.label}"
							title={c.label}
						>
							{#if c.icon}
								<Icon icons={data.icons} signal={c.icon} label="" size={20} />
							{:else if c.cube}
								<span class="grid size-5 place-items-center"><RenderIcon class="size-4 text-amber-300" /></span>
							{:else}
								{c.label}
							{/if}
							<span aria-hidden="true" class="text-amber-400">×</span>
						</a>
					{/if}
				{/each}
			</div>
		{/if}
		<div class="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm text-stone-400">
			<div class="flex items-center gap-3">
				<button
					type="button"
					class="flex items-center gap-1.5 rounded border border-stone-700 px-2.5 py-1 text-stone-200 hover:bg-stone-800 md:hidden"
					aria-controls="filters"
					aria-expanded={filtersOpen}
					onclick={() => (filtersOpen = true)}
				>
					<svg aria-hidden="true" viewBox="0 0 16 16" class="size-3.5 fill-current"><path d="M1 3h14v1.5H1zm3 4.25h8v1.5H4zM6.5 11.5h3V13h-3z" /></svg>
					Filters{#if chips.length}<span class="rounded-full bg-amber-500/20 px-1.5 text-xs text-amber-300">{chips.length}</span>{/if}
				</button>
				<p>
					{plural(data.total)}{#if data.pages > 1 && !pager.beyond}<span class="text-stone-500">{` · page ${data.params.page} of ${data.pages}`}</span>{/if}
				</p>
			</div>
			<!-- A GET form, so it works without JS; with JS, changing the select submits it and keeps focus and scroll. -->
			<form method="GET" data-sveltekit-reset="false">
				<!-- A new order starts again at its first page. -->
				{#each [...page.url.searchParams].filter(([k]) => k !== 'sort' && k !== 'p') as [k, v], i (i)}
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
				{#if pager.beyond}
					There are no more results. <a class="text-amber-300 underline" href={pageHref(1)} rel={searchRel(pageHref(1))}>Back to the first page</a>
				{:else if chips.length || data.params.q}
					No prints match. Remove a filter above to widen the search.
				{:else}
					No prints yet. Run <code class="text-amber-300">bun run ingest --top 5</code> to pull some in.
				{/if}
			</p>
		{/if}
		<ul class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
			{#each data.results as p, i (p.id)}
				<!-- The grid is at most 3 wide: the first row's pictures load at once, the rest lazily. -->
				<ResultCard print={p} eager={i < 3} {toggle} {active} renderOnly={data.params.render} icons={data.icons} />
			{/each}
		</ul>
		{#if (pager.prev || pager.next) && !pager.beyond}
			<nav aria-label="Results pages" class="mt-6 flex items-center justify-between gap-4 text-sm">
				{#if pager.prev}
					<a class="rounded bg-stone-800 px-3 py-1.5 text-stone-200 hover:bg-stone-700" href={pager.prev} rel={searchRel(pager.prev)}>‹ Previous</a>
				{:else}
					<span></span>
				{/if}
				<span class="text-stone-500">Page {data.params.page} of {data.pages}</span>
				{#if pager.next}
					<a class="rounded bg-stone-800 px-3 py-1.5 text-stone-200 hover:bg-stone-700" href={pager.next} rel={searchRel(pager.next)}>Next ›</a>
				{:else}
					<span></span>
				{/if}
			</nav>
			{#if !pager.next && data.total > data.pages * data.pageSize}
				<p class="mt-3 text-center text-sm text-stone-500">
					Showing the first {(data.pages * data.pageSize).toLocaleString('en')} of {plural(data.total)}. Add a filter or search text to narrow them.
				</p>
			{/if}
		{/if}
	</section>
</div>
