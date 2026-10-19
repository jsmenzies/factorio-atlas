<script lang="ts">
	import { goto } from '$app/navigation';
	import { page as route } from '$app/state';
	import BlueprintIcons from '#lib/components/BlueprintIcons.svelte';
	import BookPages from '#lib/components/BookPages.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import InlineViewer from '#lib/components/InlineViewer.svelte';
	import Lightbox from '#lib/components/Lightbox.svelte';
	import MakesStrip from '#lib/components/MakesStrip.svelte';
	import RichText from '#lib/components/RichText.svelte';
	import {
		bookProducts,
		describeBook,
		describeNode,
		describePrint,
		describeSetup,
		infraCards,
		pageInfra,
		pageTitle,
		ROLE_CLASS,
		ROLE_LABEL
	} from '#lib/describe.js';
	import { formatRate, imgurUrl, signalName, sourceUrl } from '#lib/format.js';
	import type { IconKind } from '#lib/icons.js';
	import { plainText } from '#lib/richtext.js';
	import type { NodeAnalysis, Role } from '#lib/server/pipeline/analyze.js';
	import { usefulTags } from '#lib/tags.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const p = $derived(data.print);
	const a = $derived(data.analysis);
	const pages = $derived(a.nodes.filter((n) => n.kind === 'blueprint'));
	const books = $derived(a.nodes.filter((n) => n.kind === 'blueprint_book'));
	const single = $derived(pages.length === 1 ? pages[0] : null);
	const root = $derived(a.nodes.find((n) => n.path === ''));
	const products = $derived(bookProducts(pages, (s) => data.sections[s] ?? 'Other'));
	const cards = $derived(infraCards(a));

	// Author tags that add something to our analysis; the first few show, the rest on request.
	const TAG_LIMIT = 4;
	const tags = $derived(usefulTags(p.tags, a.mods));
	let showAllTags = $state(false);

	// Finding a page in a big book: by what it makes (click a product), its role, or its name.
	type PageFilter = { kind: 'item'; signal: string } | { kind: 'role'; role: Role } | null;
	let filter = $state<PageFilter>(null);
	let query = $state('');
	const pickItem = (signal: string) => (filter = filter?.kind === 'item' && filter.signal === signal ? null : { kind: 'item', signal });
	const pickRole = (role: Role) => (filter = filter?.kind === 'role' && filter.role === role ? null : { kind: 'role', role });
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

	// Long sidebar lists show 8 rows until opened.
	const LIST_LIMIT = 8;
	let openLists = $state<Record<string, boolean>>({});
	const title = $derived(String(p.title));
	const versionHref = (v: string) => `/?version=${encodeURIComponent(v)}`;

	// The selected book page lives in the URL (`?page=3/1`) so links land on it. This page's
	// load doesn't read the URL, so changing it doesn't reload anything but the viewer.
	const selected = $derived.by(() => {
		const want = route.url.searchParams.get('page');
		return pages.find((n) => n.path === want) ?? pages[0] ?? null;
	});
	const selectedIndex = $derived(selected ? pages.indexOf(selected) : -1);
	const select = (path: string) =>
		goto(`?page=${encodeURIComponent(path)}`, { replace: true, reset: false });
	const step = (by: number) => {
		const next = pages[selectedIndex + by];
		if (next) select(next.path);
	};

	let screenshot = $state<Lightbox>();
	// Long descriptions (often changelogs) are clamped so the cards below stay in reach.
	const longDescription = $derived(String(p.description_md ?? '').length > 900);
	let showFullDescription = $state(false);
	// Styles for the description's sanitised Markdown (descriptionHtml): p, h3–h6, lists, quotes, code, links, images.
	const prose = [
		'space-y-2 text-sm leading-relaxed break-words text-stone-300',
		'[&_a]:text-amber-400 [&_a]:underline [&_a]:decoration-amber-400/40 [&_a:hover]:text-amber-300',
		'[&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-stone-100 [&_h4]:font-semibold [&_h4]:text-stone-100',
		'[&_h5]:font-semibold [&_h5]:text-stone-200 [&_h6]:font-semibold [&_h6]:text-stone-200 [&_strong]:text-stone-100',
		'[&_ul]:list-disc [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:pl-5 [&_li]:my-0.5 [&_li]:marker:text-stone-500',
		'[&_blockquote]:border-l-2 [&_blockquote]:border-stone-700 [&_blockquote]:pl-3 [&_blockquote]:text-stone-400',
		'[&_code]:rounded [&_code]:bg-stone-800 [&_code]:px-1 [&_code]:text-[0.85em] [&_pre]:overflow-x-auto [&_pre]:rounded',
		'[&_pre]:bg-stone-900 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_hr]:border-stone-800',
		'[&_img]:my-2 [&_img]:h-auto [&_img]:max-h-[32rem] [&_img]:max-w-full [&_img]:rounded'
	].join(' ');

	type CopyState = 'idle' | 'copying' | 'done' | 'failed';
	let copied = $state<{ book: CopyState; page: CopyState }>({ book: 'idle', page: 'idle' });
	const copy = async (which: 'book' | 'page') => {
		copied[which] = 'copying';
		try {
			const query = which === 'page' && selected ? `?page=${encodeURIComponent(selected.path)}` : '';
			const res = await fetch(`/prints/${p.id}/string${query}`);
			if (!res.ok) throw new Error(String(res.status));
			await navigator.clipboard.writeText(await res.text());
			copied[which] = 'done';
		} catch {
			copied[which] = 'failed';
		}
		setTimeout(() => (copied[which] = 'idle'), 2000);
	};
	const copyLabel = (s: CopyState, idle: string) => ({ idle, copying: 'Copying…', done: 'Copied!', failed: 'Copy failed' })[s];

	const evidence = $derived(
		a.spaceAgeEvidence.slice(0, 3).join(', ') + (a.spaceAgeEvidence.length > 3 ? ` +${a.spaceAgeEvidence.length - 3}` : '')
	);
	// Rows with nothing to say are dropped; belts, trains, power, defence and circuits have their own cards.
	const facts = $derived(
		(
			[
				['Saved in', a.gameVersion ? `Factorio ${a.gameVersion}` : 'unknown', a.gameVersion ? versionHref(a.gameVersion) : undefined],
				['Claims', a.claimedVersions.join(', ')],
				['Space Age', a.requiresSpaceAge ? `required (${evidence})` : 'not required'],
				['Stage', a.stageGuess ?? ''],
				['Contents', a.bookCount ? `${a.blueprintCount} blueprints in ${a.bookCount} book${a.bookCount === 1 ? '' : 's'}` : ''],
				['Entities', a.entityCount.toLocaleString()],
				['Beacons', a.beacons ? String(a.beacons) : ''],
				['Planets', a.planets.join(', ')],
				['Placeable on', a.placeableOn?.join(', ') ?? ''],
				['Mentions', a.claimedPlanets?.join(', ') ?? ''],
				['Mods', a.mods.join(', ') || 'none detected'],
				['Unknown names', a.unknownNames?.join(', ') ?? '']
			] as [string, string, string?][]
		).filter(([, v]) => v)
	);

	/** What a page consumes from outside, with its nameplate rate when we know it. */
	const takes = (n: NodeAnalysis) => n.inputs.map((s) => ({ signal: s, rate: n.rates[s] < 0 ? -n.rates[s] : null }));
	const bare = (s: string) => s.slice(s.indexOf(':') + 1);
</script>

<svelte:head><title>{plainText(title)} · Blueprint Atlas</title></svelte:head>

{#snippet pageDetail(n: NodeAnalysis)}
	{@const setup = describeSetup(n)}
	{@const infra = pageInfra(n)}
	{@const inputs = takes(n)}
	<dl class="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[7rem_1fr]">
		{#if n.claimedRate || n.estimatedRate}
			<dt class="text-stone-500">Rate</dt>
			<dd class="text-stone-200">
				{#if n.claimedRate}{formatRate(n.claimedRate)} claimed{/if}{#if n.claimedRate && n.estimatedRate}<span class="text-stone-500"> · </span>{/if}{#if n.estimatedRate}≈ {formatRate(
						n.estimatedRate
					)} nameplate{/if}
			</dd>
		{/if}
		{#if inputs.length}
			<dt class="text-stone-500">Takes</dt>
			<dd class="flex flex-wrap gap-x-3 gap-y-1">
				{#each inputs as t (t.signal)}
					<span class="flex items-center gap-1 text-stone-300">
						<Icon icons={data.icons} kind="item" name={bare(t.signal)} label={signalName(t.signal)} size={18} />
						{signalName(t.signal)}{#if t.rate}<span class="text-stone-500">{formatRate(t.rate)}</span>{/if}
					</span>
				{/each}
			</dd>
		{/if}
		{#if setup}
			<dt class="text-stone-500">Built with</dt>
			<dd class="text-stone-300">{setup}</dd>
		{/if}
		{#each infra as line (line.title)}
			<dt class="text-stone-500">{line.title}</dt>
			<dd class="text-stone-300">{line.text}</dd>
		{/each}
		<dt class="text-stone-500">Size</dt>
		<dd class="text-stone-300">
			{n.width && n.height ? `${n.width}×${n.height} tiles · ` : ''}{n.entityCount.toLocaleString()} entities{n.gameVersion
				? ` · Factorio ${n.gameVersion}`
				: ''}
		</dd>
	</dl>
{/snippet}

<a href="/" class="text-sm text-stone-400 hover:text-amber-300">← Search</a>

<div class="mt-3 grid gap-8 lg:grid-cols-[1fr_20rem]">
	<div class="min-w-0 space-y-6">
		<header class="space-y-2">
			<div class="flex items-center gap-3">
				{#if root?.icons.length}<BlueprintIcons icons={data.icons} signals={root.icons} kind={root.kind} size={48} />{/if}
				<h1 class="text-2xl font-semibold text-stone-100"><RichText text={title} icons={data.icons} size={26} /></h1>
			</div>
			<p class="text-sm text-stone-400">
				by {p.author_name ?? 'unknown author'} · ★ {p.favorites} ·
				<a class="text-amber-400 underline" href={sourceUrl(String(p.id))} rel="external">original on factorioprints.com</a>
			</p>
			<!-- On phones the sidebar (and its copy button) sits at the very bottom. -->
			<button onclick={() => copy('book')} class="w-full rounded bg-amber-500 px-4 py-2 font-medium text-stone-950 hover:bg-amber-400 lg:hidden">
				{copyLabel(copied.book, single ? 'Copy blueprint string' : 'Copy whole book')}
			</button>
			<div class="flex flex-wrap items-center gap-1 text-xs">
				<!-- In a book, role chips filter the page grid below. -->
				{#each Object.entries(a.roles) as [r, k] (r)}
					{@const role = r as Role}
					{#if single}
						<span class="rounded px-1.5 py-0.5 {ROLE_CLASS[role]}">{ROLE_LABEL[role]}</span>
					{:else}
						<button
							type="button"
							onclick={() => pickRole(role)}
							aria-pressed={filter?.kind === 'role' && filter.role === role}
							title="Show only {ROLE_LABEL[role].toLowerCase()} pages"
							class="rounded px-1.5 py-0.5 {ROLE_CLASS[role]} {filter?.kind === 'role' && filter.role === role ? 'ring-1 ring-amber-400' : ''}"
							>{ROLE_LABEL[role]} · {k}</button
						>
					{/if}
				{/each}
				{#each showAllTags ? tags : tags.slice(0, TAG_LIMIT) as t (t.raw)}<a
						href="/?{t.param.key}={encodeURIComponent(t.param.value)}"
						title="Author tag {t.raw}: search for it"
						class="rounded bg-stone-800 px-1.5 py-0.5 text-stone-300 hover:bg-stone-700 hover:text-amber-300"
						><span class="text-stone-500">{t.category}</span> {t.label}</a
					>{/each}
				{#if tags.length > TAG_LIMIT}
					<button type="button" class="rounded px-1.5 py-0.5 text-stone-400 hover:text-amber-300" onclick={() => (showAllTags = !showAllTags)}>
						{showAllTags ? 'fewer' : `+${tags.length - TAG_LIMIT} tags`}
					</button>
				{/if}
			</div>
		</header>

		<!-- What this gives you: the book in one line, then main products with rates. -->
		<section aria-label="What this print is" class="space-y-3">
			{#if !single}<p class="text-stone-300">{describeBook(a)}</p>{/if}
			{#if products.main.length || products.groups.length}
				<MakesStrip
					main={products.main}
					groups={products.groups}
					icons={data.icons}
					active={filter?.kind === 'item' ? filter.signal : null}
					onpick={single ? undefined : pickItem}
				/>
			{:else if single}
				<p class="text-stone-200">{describePrint(a)}</p>
			{/if}
		</section>

		{#if single}
			<section class="space-y-3">
				<InlineViewer printId={String(p.id)} path={single.path} />
				{@render pageDetail(single)}
			</section>
		{:else if selected}
			{@const t = pageTitle(selected)}
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
							onclick={() => (filter = null)}
							class="flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-sm text-amber-200 hover:bg-amber-500/20"
							aria-label="Remove filter: {filterLabel}">{filterLabel} <span class="text-amber-400">×</span></button
						>
					{/if}
					{#if filter || query.trim()}<span class="text-sm text-stone-500">{shownPages.length} of {pages.length}</span>{/if}
				</div>
				{#if shownPages.length}
					<BookPages pages={shownPages} {books} selected={selected.path} onselect={select} icons={data.icons} />
				{:else}
					<p class="rounded border border-dashed border-stone-700 p-4 text-sm text-stone-500">No pages match. Clear the filter or search to see them all.</p>
				{/if}
			</section>

			<section class="space-y-3 rounded-lg border border-stone-800 bg-stone-900/40 p-3" aria-label="Selected page">
				<div class="flex flex-wrap items-center gap-2">
					<div class="flex items-center gap-1">
						<button
							class="rounded bg-stone-800 px-2 py-0.5 hover:bg-stone-700 disabled:opacity-40"
							disabled={selectedIndex <= 0}
							onclick={() => step(-1)}
							aria-label="Previous page">‹</button
						>
						<button
							class="rounded bg-stone-800 px-2 py-0.5 hover:bg-stone-700 disabled:opacity-40"
							disabled={selectedIndex >= pages.length - 1}
							onclick={() => step(1)}
							aria-label="Next page">›</button
						>
					</div>
					{#if selected.icons.length}<BlueprintIcons icons={data.icons} signals={selected.icons} size={36} />{/if}
					<div class="min-w-0 flex-1">
						<h3 class="truncate font-medium {t.derived ? 'text-stone-300 italic' : 'text-stone-100'}">
							<RichText text={t.text} icons={data.icons} size={18} />
						</h3>
						<p class="truncate text-xs text-stone-400">{selectedIndex + 1} of {pages.length} · {describeNode(selected)}</p>
					</div>
					<button
						onclick={() => copy('page')}
						class="rounded border border-amber-500/60 px-3 py-1 text-sm text-amber-300 hover:bg-amber-500/10"
						title="Copy just this page as its own blueprint">{copyLabel(copied.page, 'Copy this page')}</button
					>
				</div>
				<InlineViewer printId={String(p.id)} path={selected.path} />
				{@render pageDetail(selected)}
			</section>
		{/if}

		{#if data.descriptionHtml}
			<section>
				<h2 class="mb-2 font-semibold">Description</h2>
				<!-- Sanitised server-side by renderDescription (#lib/server/markdown.js): safe for {@html}. -->
				<div class="{prose} {longDescription && !showFullDescription ? 'line-clamp-12' : ''}">
					{@html data.descriptionHtml}
				</div>
				{#if longDescription}
					<button class="mt-1 text-sm text-amber-400 hover:text-amber-300" onclick={() => (showFullDescription = !showFullDescription)}>
						{showFullDescription ? 'Show less' : 'Show full description'}
					</button>
				{/if}
			</section>
		{/if}

		{#if cards.length}
			<section class="space-y-2" aria-label="Infrastructure">
				{#if !single}<h2 class="font-semibold">Whole book</h2>{/if}
				<div class="grid gap-3 sm:grid-cols-2">
					{#each cards as card (card.cat)}
						<div class="rounded-lg border border-stone-800 p-3">
							<h3 class="text-xs font-semibold tracking-wide text-stone-400 uppercase">{card.title}</h3>
							<p class="mt-1 text-sm text-stone-200">{card.headline}</p>
							<ul class="mt-2 space-y-1 text-sm">
								{#each Object.entries(a.byCategory[card.cat] ?? {}).slice(0, 6) as [name, n] (name)}
									<li class="flex items-center gap-2">
										<Icon icons={data.icons} kind="entity" {name} label={signalName(name)} size={18} />
										<span class="min-w-0 flex-1 truncate text-stone-300">{signalName(name)}</span>
										<span class="text-stone-500">{n.toLocaleString()}</span>
									</li>
								{/each}
							</ul>
						</div>
					{/each}
				</div>
			</section>
		{/if}
	</div>

	<aside class="space-y-6">
		<div class="space-y-2">
			<button onclick={() => copy('book')} class="w-full rounded bg-amber-500 px-4 py-2 font-medium text-stone-950 hover:bg-amber-400">
				{copyLabel(copied.book, single ? 'Copy blueprint string' : 'Copy whole book')}
			</button>
		</div>

		{#if p.image_id}
			<button
				onclick={() => screenshot?.open()}
				class="group relative block aspect-video w-full overflow-hidden rounded-lg border border-stone-800 bg-stone-900"
				aria-label="Expand the author's screenshot"
			>
				<img
					src={imgurUrl(String(p.image_id), p.image_type as string | null, 'large')}
					alt="Screenshot of {plainText(title)}"
					class="h-full w-full object-cover transition group-hover:scale-105"
					loading="lazy"
				/>
				<span class="absolute bottom-2 left-2 rounded bg-stone-950/80 px-2 py-0.5 text-xs text-stone-300">Author's screenshot ⤢</span>
			</button>
			<Lightbox bind:this={screenshot} label="Screenshot of {plainText(title)}">
				<img
					src={imgurUrl(String(p.image_id), p.image_type as string | null, 'original')}
					alt="Screenshot of {plainText(title)}"
					class="mx-auto block max-h-[calc(95vh-3rem)] max-w-[95vw] object-contain"
				/>
			</Lightbox>
		{/if}

		<dl class="divide-y divide-stone-800 rounded-lg border border-stone-800 text-sm">
			{#each facts as [k, v, href] (k)}
				<div class="flex justify-between gap-4 px-3 py-2">
					<dt class="text-stone-400">{k}</dt>
					<dd class="text-right">
						{#if k === 'Claims'}
							{#each a.claimedVersions as cv, i (cv)}{i ? ', ' : ''}<a class="underline decoration-stone-600 hover:text-amber-300" href={versionHref(cv)}>{cv}</a
								>{/each}
						{:else if href}<a class="underline decoration-stone-600 hover:text-amber-300" {href} title="Search prints saved in this version">{v}</a>
						{:else}{v}{/if}
					</dd>
				</div>
			{/each}
		</dl>

		{#if products.main.length}
			<section>
				<h2
					class="mb-2 text-xs font-semibold tracking-wide text-stone-400 uppercase"
					title="Best single page's rate: claimed by the author, or ≈ nameplate with every machine running flat out"
				>
					Main products
				</h2>
				<ul class="space-y-1 text-sm">
					{#each products.main as m (m.signal)}
						<li class="flex items-center gap-2">
							<Icon icons={data.icons} kind="item" name={bare(m.signal)} label={signalName(m.signal)} />
							<span class="min-w-0 flex-1 truncate">{signalName(m.signal)}</span>
							{#if m.rate}
								<span class="text-emerald-300">{m.claimed ? '' : '≈ '}{formatRate(m.rate)}</span>
							{:else}
								<span class="text-xs text-stone-500" title="Smelting and mining are not rated yet">not rated</span>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#snippet counts(title: string, kind: IconKind, c: Record<string, number>)}
			{@const rows = Object.entries(c)}
			<section>
				<h2 class="mb-2 text-xs font-semibold tracking-wide text-stone-400 uppercase">{title}</h2>
				<ul class="space-y-1 text-sm">
					{#each openLists[title] ? rows : rows.slice(0, LIST_LIMIT) as [name, n] (name)}
						{@const [base, quality] = name.split('@')}
						<li class="flex items-center gap-2">
							<Icon icons={data.icons} {kind} name={base} label={signalName(base)} />
							<span class="min-w-0 flex-1 truncate"
								>{signalName(base)}{#if quality}<span class="ml-1 text-xs text-amber-300">◆ {quality}</span>{/if}</span
							>
							<span class="text-stone-500">{n}</span>
						</li>
					{:else}
						<li class="text-stone-600">—</li>
					{/each}
				</ul>
				{#if rows.length > LIST_LIMIT}
					<button type="button" class="mt-1 text-xs text-stone-400 hover:text-amber-300" onclick={() => (openLists[title] = !openLists[title])}>
						{openLists[title] ? 'Show fewer' : `Show all ${rows.length}`}
					</button>
				{/if}
			</section>
		{/snippet}

		{#if Object.keys(a.recipes).length}{@render counts('Recipes (machines)', 'recipe', a.recipes)}{/if}
		{@render counts('Entities', 'entity', a.entities)}
		{#if Object.keys(a.modules).length}{@render counts('Modules', 'item', a.modules)}{/if}

		<section class="rounded-lg border border-dashed border-stone-700 p-3 text-xs text-stone-500">
			<h2 class="mb-1 font-semibold text-stone-400">Analyzer v{a.analyzerVersion} limits</h2>
			<ul class="list-disc space-y-0.5 pl-4">
				{#each a.limits as l (l)}<li>{l}</li>{/each}
			</ul>
		</section>
	</aside>
</div>
