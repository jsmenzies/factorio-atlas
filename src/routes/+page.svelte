<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Icon from '#lib/components/Icon.svelte';
	import RichText from '#lib/components/RichText.svelte';
	import SearchBox from '#lib/components/SearchBox.svelte';
	import type { IconKind } from '#lib/icons.js';
	import { pickParam, type PickerItem } from '#lib/picker.js';
	import { imgurUrl, signalName } from '#lib/format.js';
	import { parseTag } from '#lib/tags.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** Link to the current search with one param set (or cleared when it already has that value). */
	const toggle = (key: string, value: string) => {
		const u = new URL(page.url.href);
		if (u.searchParams.get(key) === value) u.searchParams.delete(key);
		else u.searchParams.set(key, value);
		return `${u.pathname}${u.search}`;
	};
	const active = (key: string, value: string) => page.url.searchParams.get(key) === value;

	/** Picking an item filters to prints that make it (a building: that use it); the typed text only found it, so drop it. */
	const pickItem = (item: PickerItem) => {
		const u = new URL(page.url.href);
		u.searchParams.set(pickParam(item), item.signal);
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
	const bare = (signal: string) => signal.slice(signal.indexOf(':') + 1);

	/** Every active filter as a removable tag; clicking one clears just that filter. */
	const chips = $derived(
		(
			[
				data.params.makes && { key: 'makes', value: data.params.makes, label: itemLabel(data.params.makes), icon: bare(data.params.makes) },
				data.params.takes && { key: 'takes', value: data.params.takes, label: `Takes ${itemLabel(data.params.takes)}`, icon: bare(data.params.takes) },
				data.params.uses && { key: 'uses', value: data.params.uses, label: `Uses ${itemLabel(data.params.uses)}`, icon: bare(data.params.uses), kind: 'entity' },
				data.params.recipe && { key: 'recipe', value: data.params.recipe, label: `Recipe ${signalName(data.params.recipe)}`, icon: data.params.recipe, kind: 'recipe' },
				data.params.module && { key: 'module', value: data.params.module, label: `Module ${signalName(data.params.module)}`, icon: data.params.module },
				data.params.version && { key: 'version', value: data.params.version, label: `Factorio ${data.params.version}` },
				data.params.tag && { key: 'tag', value: data.params.tag, label: parseTag(data.params.tag).label },
				data.params.spaceAge && { key: 'spaceAge', value: data.params.spaceAge, label: data.params.spaceAge === 'yes' ? 'Space Age' : 'No Space Age needed' },
				data.params.circuits && { key: 'circuits', value: '1', label: 'Uses circuits' },
				data.params.trains && { key: 'trains', value: '1', label: 'Uses trains' }
			] as const
		).filter((c) => !!c) as { key: string; value: string; label: string; icon?: string; kind?: IconKind }[]
	);
</script>

<!-- Enter submits (the input is type="search"); the active filters and sort ride along as hidden inputs. -->
<form method="GET" role="search" class="mb-6 flex">
	{#key data.params.q}
		<SearchBox value={data.params.q} items={data.picker} icons={data.icons} onpick={pickItem} />
	{/key}
	{#each ['makes', 'takes', 'uses', 'recipe', 'module', 'version', 'tag', 'spaceAge', 'circuits', 'trains', 'sort'] as key (key)}
		{#if page.url.searchParams.get(key)}
			<input type="hidden" name={key} value={page.url.searchParams.get(key)} />
		{/if}
	{/each}
</form>

<div class="grid gap-6 md:grid-cols-[16rem_1fr]">
	<aside class="space-y-6 text-sm">
		{#snippet facet(title: string, key: string, items: { value: string; n: number }[], label: (v: string) => string, icon: IconKind | null = null)}
			<section>
				<h2 class="mb-2 text-xs font-semibold tracking-wide text-stone-400 uppercase">{title}</h2>
				{#if items.length === 0}
					<p class="text-stone-600">—</p>
				{/if}
				<ul class="space-y-0.5">
					{#each items as f (f.value)}
						<li>
							<a
								href={toggle(key, f.value)}
								class="flex items-center gap-2 rounded px-2 py-0.5 hover:bg-stone-800 {active(key, f.value)
									? 'bg-amber-500/15 text-amber-300'
									: ''}"
							>
								{#if icon}
									<Icon icons={data.icons} kind={icon} name={f.value.slice(f.value.indexOf(':') + 1)} label={label(f.value)} size={18} />
								{/if}
								<span class="min-w-0 flex-1 truncate">{label(f.value)}</span><span class="text-stone-500">{f.n}</span>
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/snippet}

		{@render facet('Makes', 'makes', data.facets.makes.slice(0, 25), signalName, 'item')}
		{@render facet('Built with', 'uses', data.facets.uses.slice(0, 25), itemLabel, 'entity')}
		{@render facet('Game version', 'version', data.facets.versions, (v) => v)}

		<section>
			<h2 class="mb-2 text-xs font-semibold tracking-wide text-stone-400 uppercase">Features</h2>
			<ul class="space-y-0.5">
				{#each [['spaceAge', 'no', 'No Space Age needed'], ['spaceAge', 'yes', 'Space Age'], ['circuits', '1', 'Uses circuits'], ['trains', '1', 'Uses trains']] as [k, v, l] (k + v)}
					<li>
						<a
							href={toggle(k, v)}
							class="block rounded px-2 py-0.5 hover:bg-stone-800 {active(k, v) ? 'bg-amber-500/15 text-amber-300' : ''}"
							>{l}</a
						>
					</li>
				{/each}
			</ul>
		</section>
	</aside>

	<section>
		{#if chips.length}
			<div class="mb-3 flex flex-wrap gap-2 text-sm">
				{#each chips as c (c.key)}
					<a
						href={toggle(c.key, c.value)}
						class="flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-500/10 py-0.5 pr-3 text-amber-200 hover:bg-amber-500/20 {c.icon
							? 'pl-1'
							: 'pl-3'}"
						aria-label="Remove filter: {c.label}"
					>
						{#if c.icon}<Icon icons={data.icons} kind={c.kind ?? 'item'} name={c.icon} label="" size={20} />{/if}
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
				<li class="overflow-hidden rounded-lg border border-stone-800 bg-stone-900 hover:border-stone-600">
					<a href="/prints/{p.id}" class="block">
						{#if p.image_id}
							<img
								src={imgurUrl(p.image_id, p.image_type)}
								alt=""
								loading="lazy"
								class="aspect-video w-full bg-stone-800 object-cover"
							/>
						{/if}
						<div class="space-y-2 p-3">
							<h3 class="leading-snug font-medium text-stone-100"><RichText text={p.title} icons={data.icons} size={18} /></h3>
							<p class="text-xs text-stone-500">
								{p.author_name ?? 'unknown author'} · ★ {p.favorites} · {p.blueprint_count} blueprint{p.blueprint_count === 1
									? ''
									: 's'} · {p.entity_count} entities
							</p>
						</div>
					</a>
					<!-- Outside the card link: version and Space Age badges are filter links of their own. -->
					<div class="space-y-2 px-3 pb-3">
							<div class="flex flex-wrap gap-1 text-xs">
								{#if p.game_version}<a
										href={toggle('version', p.game_version)}
										title="Filter by Factorio {p.game_version}"
										class="rounded bg-stone-800 px-1.5 py-0.5 hover:bg-stone-700 {active('version', p.game_version) ? 'ring-1 ring-amber-500' : ''}"
										>saved in {p.game_version}</a
									>{/if}
								{#each p.claimed_versions as v (v)}<a
										href={toggle('version', v)}
										title="Filter by Factorio {v}"
										class="rounded bg-sky-900/50 px-1.5 py-0.5 text-sky-300 hover:bg-sky-800/60 {active('version', v) ? 'ring-1 ring-amber-500' : ''}"
										>{v}</a
									>{/each}
								{#if p.requires_space_age}<a
										href={toggle('spaceAge', 'yes')}
										title="Filter by Space Age"
										class="rounded bg-violet-900/60 px-1.5 py-0.5 text-violet-300 hover:bg-violet-800/60 {active('spaceAge', 'yes') ? 'ring-1 ring-amber-500' : ''}"
										>Space Age</a
									>{/if}
								{#each p.planets as pl (pl)}<span class="rounded bg-emerald-900/50 px-1.5 py-0.5 text-emerald-300">{pl}</span>{/each}
								{#each p.mods as m (m)}<span class="rounded bg-rose-900/50 px-1.5 py-0.5 text-rose-300">{m}</span>{/each}
							</div>
							{#if p.outputs.length}
								<p class="flex flex-wrap items-center gap-1 text-xs text-stone-400">
									{#each p.outputs.slice(0, 8) as o (o)}
										<Icon icons={data.icons} kind="item" name={o.slice(o.indexOf(':') + 1)} label={signalName(o)} size={20} />
									{/each}
									{#if p.outputs.length > 8}<span>+{p.outputs.length - 8}</span>{/if}
								</p>
							{/if}
					</div>
				</li>
			{/each}
		</ul>
	</section>
</div>
