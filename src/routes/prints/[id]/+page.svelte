<script lang="ts">
	import { goto } from '$app/navigation';
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { page as route } from '$app/state';
	import PageMeta from '#lib/components/PageMeta.svelte';
	import OwnerLinks from '#lib/components/upload/OwnerLinks.svelte';
	import BookScope from '#lib/components/print/BookScope.svelte';
	import PagesSection, { type PageFilter } from '#lib/components/print/PagesSection.svelte';
	import AboutTab from '#lib/components/print/AboutTab.svelte';
	import EntitiesTab from '#lib/components/print/EntitiesTab.svelte';
	import InputsTab from '#lib/components/print/InputsTab.svelte';
	import OverviewTab from '#lib/components/print/OverviewTab.svelte';
	import PrintHero from '#lib/components/print/PrintHero.svelte';
	import PrintSidebar from '#lib/components/print/PrintSidebar.svelte';
	import PrintTabs, { type Tab, type TabId } from '#lib/components/print/PrintTabs.svelte';
	import ProducesTab from '#lib/components/print/ProducesTab.svelte';
	import RecipesTab from '#lib/components/print/RecipesTab.svelte';
	import SelectedPage from '#lib/components/print/SelectedPage.svelte';
	import { bookProducts, describeNode, describePrint, metaDescription, pageTitle } from '#lib/describe.js';
	import { groupPages } from '#lib/book-groups.js';
	import { signalName } from '#lib/format.js';
	import { plainText } from '#lib/richtext.js';
	import type { NodeAnalysis, Role } from '#lib/server/pipeline/analyze.js';
	import { usefulTags } from '#lib/tags.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const p = $derived(data.print);
	const a = $derived(data.analysis);
	const pages = $derived(a.nodes.filter((n) => n.kind === 'blueprint'));
	const single = $derived(pages.length === 1 ? pages[0] : null);
	const root = $derived(a.nodes.find((n) => n.path === ''));
	const sectionOf = (s: string) => data.sections[s] ?? 'Other';
	const products = $derived(bookProducts(pages, sectionOf));
	const countOf = (ps: typeof products) => ps.main.length + ps.groups.reduce((n, g) => n + g.items.length, 0);
	const produced = $derived(countOf(products));
	// Made and used up inside the print: shown after what it makes, never as a product.
	const insideOf = (ps: typeof products, from: NodeAnalysis[], inputs: string[]) => {
		const out = new Set([...ps.main, ...ps.groups.flatMap((g) => g.items)].map((m) => m.signal));
		return [...new Set(from.flatMap((n) => n.intermediates))].filter((s) => !out.has(s) && !inputs.includes(s));
	};
	const intermediates = $derived(insideOf(products, pages, a.inputs));
	const title = $derived(String(p.title));
	// Author tags that add something to our analysis.
	const tags = $derived(usefulTags(p.tags, a.mods));

	// The page state lives in the URL so links land on it: the book page (`?page=3/1`) and the tab
	// (`?tab=entities`). Changing either is a shallow navigation: the URL changes (page.shallow.url)
	// but no load runs and the data stays.
	const query = $derived((route.shallow?.url ?? route.url).searchParams);
	const selected = $derived(pages.find((n) => n.path === query.get('page')) ?? pages[0] ?? null);
	const selectedIndex = $derived(selected ? pages.indexOf(selected) : -1);
	// Pages without a game render get no viewer.
	const rendered = $derived(new Set(Object.keys(data.previews)));
	// The header shows a rendered page when the author has no screenshot: its number in the book.
	const coverIndex = $derived(!single && data.cover ? pages.findIndex((n) => n.path === data.cover?.path) + 1 || null : null);
	// Each book page has its own URL, for links and search engines; the first page's is the print's.
	const pageHref = (path: string) => (path === pages[0]?.path ? `/prints/${p.id}` : `/prints/${p.id}?page=${encodeURIComponent(path)}`);
	// A book page's URL opens on its render; the first page's is the print's own, so it says so. Picking a page
	// is a history entry, as following its link would be (each book page is a page of its own), so Back steps back
	// through the pages picked; switching tabs isn't (`replace`): tabs are views of one print, and Back leaves it.
	const select = (path: string, replace = false) =>
		goto(path === pages[0]?.path ? `${pageHref(path)}?tab=pages` : pageHref(path), { shallow: true, replace });
	// In a book, the counting tabs show the whole book or the selected page (BookScope).
	// A page picked on the render tab (or named in the URL) is the one the other tabs show.
	let scope = $state<'book' | 'page'>(untrack(() => (query.has('page') ? 'page' : 'book')));
	const selectPage = (path: string) => {
		scope = 'page';
		select(path);
	};
	const scoped = $derived(!single && scope === 'page' ? selected : null);
	const scopedProducts = $derived(scoped ? bookProducts([scoped], sectionOf, 8, true) : products);
	const scopedInside = $derived(scoped ? insideOf(scopedProducts, [scoped], scoped.inputs) : intermediates);
	/** Picks a page without leaving `tab`. */
	const selectOn = (tab: TabId) => (path: string) => {
		const href = pageHref(path);
		goto(`${href}${href.includes('?') ? '&' : '?'}tab=${tab}`, { shallow: true });
	};

	const tabs = $derived(
		[
			{ id: 'overview', label: 'Overview' },
			{
				id: 'pages',
				label: single ? (rendered.has(single.path) ? 'Render' : 'Blueprint') : rendered.size ? 'Render & pages' : 'Pages',
				count: single ? undefined : pages.length
			},
			produced && { id: 'produces', label: 'Produces', count: single ? produced : undefined },
			// A book's counts would be ambiguous: these tabs switch between the whole book and one page.
			{ id: 'entities', label: 'Entities', count: single ? a.entityCount : undefined },
			a.inputs.length && { id: 'inputs', label: 'Inputs', count: single ? a.inputs.length : undefined },
			Object.keys(a.recipes).length && { id: 'recipes', label: 'Recipes', count: single ? Object.keys(a.recipes).length : undefined },
			{ id: 'about', label: 'About' }
		].filter((t): t is Tab => !!t)
	);
	const defaultTab = $derived<TabId>(query.has('page') ? 'pages' : 'overview');
	const tab = $derived(tabs.find((t) => t.id === query.get('tab'))?.id ?? defaultTab);
	// Only the open tab is rendered (on the server too, so the page stays light), plus the pages tab,
	// whose page links let crawlers walk the whole book, and About, with the link back to the
	// original on factorioprints.com that every print carries. A tab once opened stays mounted, so
	// its search and filters survive switching away and back.
	const opened = new SvelteSet<TabId>();
	$effect(() => {
		opened.add(tab);
	});
	const shows = (id: TabId) => id === tab || id === 'pages' || id === 'about' || opened.has(id);
	const showTab = (id: TabId) => {
		const url = new URL((route.shallow?.url ?? route.url).href);
		if (id === defaultTab) url.searchParams.delete('tab');
		else url.searchParams.set('tab', id);
		goto(url.pathname + url.search, { shallow: true, replace: true });
	};

	// The Overview's picture: the selected page's render, else the biggest rendered page's (its
	// thumbnail when it has one, else the overview image).
	const preview = $derived.by(() => {
		const page = selected && rendered.has(selected.path) ? selected : pages.find((n) => n.path === data.cover?.path);
		if (!page) return null;
		const fullScreen = `/prints/${p.id}/render?page=${encodeURIComponent(page.path)}&from=overview`;
		return { url: data.previews[page.path], thumb: data.thumbs[page.path], page, index: pages.indexOf(page), total: pages.length, fullScreen };
	});
	// From the Overview, the render tab opens on the page it showed: a tab switch, so it replaces the entry too.
	const openTab = (id: TabId) => (id === 'pages' && preview && preview.page !== selected ? select(preview.page.path, true) : showTab(id));

	// A book's page bar (BookScope): the page picker's groups (stages or sub-books) and what its
	// search matches. Clicking an item on Produces or Inputs opens it searching for that item.
	const titleOf = (path: string) => {
		const n = a.nodes.find((x) => x.path === path);
		return n ? plainText(pageTitle(n).text) : 'Untitled';
	};
	const groups = $derived(groupPages(a.nodes, titleOf));
	const info = $derived(
		Object.fromEntries(
			pages.map((n) => [
				n.path,
				{
					icons: n.icons,
					find: [titleOf(n.path), describeNode(n), ...[...n.outputs, ...n.products, ...n.inputs].map(signalName)].join(' ').toLowerCase()
				}
			])
		)
	);
	let bookScope = $state<BookScope>();
	// The render tab's page grid can show one role's pages (a role chip on the Overview).
	let filter = $state<PageFilter>(null);
	const pickRole = (role: Role) => {
		const same = filter?.kind === 'role' && filter.role === role;
		filter = same ? null : { kind: 'role', role };
		if (!same) showTab('pages');
	};
	const findPages = (signal: string) => bookScope?.find(signalName(signal).toLowerCase());

	// One view per print per tab, for the "Popular" sort (lib/server/views.ts). Sent from the browser,
	// so hover preloads (which run this page's load) and most crawlers don't count; picking a book
	// page is a shallow navigation and doesn't either. A plain fetch, not navigator.sendBeacon:
	// privacy extensions (ClearURLs, for one) block every request of the "beacon" type.
	$effect(() => {
		const id = p.id;
		try {
			if (sessionStorage.getItem(`viewed:${id}`)) return;
			sessionStorage.setItem(`viewed:${id}`, '1');
		} catch {
			// Storage blocked: count it anyway.
		}
		fetch(`/prints/${id}/view`, { method: 'POST', keepalive: true }).catch(() => {});
	});

	// A book page past the first is a page of its own for search engines: title, description and canonical URL.
	const bookPage = $derived(!single && selected && selectedIndex > 0 ? selected : null);
	// What the print is, in the words people search with ("nilaus base in a book factorio blueprint"); every title says it.
	const what = $derived.by(() => {
		const kind = single ? 'blueprint' : a.nodes[0]?.kind;
		if (kind === 'blueprint_book') return 'Factorio blueprint book';
		if (kind === 'upgrade_planner') return 'Factorio upgrade planner';
		if (kind === 'deconstruction_planner') return 'Factorio deconstruction planner';
		return 'Factorio blueprint';
	});
	// A later exact copy of an earlier print (the soft fold): its pages point search engines at the original.
	const copyOf = $derived(data.related.copyOf);
	const identicalTo = $derived(data.related.identicalTo);
	const ownMeta = $derived(
		bookPage
			? {
					title: `${plainText(pageTitle(bookPage).text)} · ${plainText(title)} · Factorio blueprint · Blueprint Atlas`,
					description: metaDescription(a, p.author_name, { page: { node: bookPage, index: selectedIndex }, rendered: rendered.has(bookPage.path) }),
					canonical: pageHref(bookPage.path)
				}
			: { title: `${plainText(title)} · ${what} · Blueprint Atlas`, description: metaDescription(a, p.author_name, { rendered: rendered.size > 0, makes: [...products.main, ...products.groups.flatMap((g) => g.items)].map((m) => m.signal) }), canonical: `/prints/${p.id}` }
	);
	// A folded copy's page N points at the original's page N (an exact copy has the same pages in the same order).
	const copyCanonical = $derived.by(() => {
		if (!copyOf) return null;
		const target = selectedIndex > 0 ? data.related.copyPages[selectedIndex] : undefined;
		return target ? `/prints/${copyOf.id}?page=${encodeURIComponent(target)}` : `/prints/${copyOf.id}`;
	});
	const meta = $derived(copyCanonical ? { ...ownMeta, canonical: copyCanonical } : ownMeta);
	// Link previews show the author's screenshot, for the print and each of its book pages: our copy's
	// preview JPEG, else Imgur's while ours isn't there yet, else (gone or removed) the site's card.
	const image = $derived(data.shot.og ? { ...data.shot.og, alt: `Screenshot of ${plainText(title)}` } : undefined);

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
	const bookCopyLabel = $derived(copyLabel(copied.book, single ? 'Copy blueprint string' : 'Copy whole book'));
</script>

<PageMeta {...meta} {image} />

<PrintHero
	print={p}
	analysis={a}
	{title}
	{root}
	shot={data.shot}
	cover={data.cover}
	{coverIndex}
	copyLabel={bookCopyLabel}
	oncopy={() => copy('book')}
	icons={data.icons}
/>

<!-- The owner's Edit link comes from the browser (OwnerLinks asks /me), never this cached load. -->
<div class="mt-4 empty:hidden"><OwnerLinks printId={p.id} /></div>

{#if copyOf}
	<p class="mb-6 rounded border border-stone-800 bg-stone-900/60 px-4 py-3 text-sm text-stone-300">
		Same blueprint as <a class="text-amber-400 underline hover:text-amber-300" href="/prints/{copyOf.id}">{plainText(copyOf.title)}</a>, posted
		earlier{#if copyOf.author_name}{' '}by {copyOf.author_name}{/if}.
	</p>
{:else if identicalTo}
	<p class="mb-6 rounded border border-stone-800 bg-stone-900/60 px-4 py-3 text-sm text-stone-300">
		Identical to <a class="text-amber-400 underline hover:text-amber-300" href="/prints/{identicalTo.id}">{plainText(identicalTo.title)}</a
		>{#if identicalTo.author_name}{' '}by {identicalTo.author_name}{/if}, posted earlier.
	</p>
{/if}

<div class="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
	<div class="min-w-0">
		<PrintTabs {tabs} active={tab} onselect={showTab} />

		<div class="pt-6">
			{#if !single && selected && tab !== 'overview' && tab !== 'pages' && tab !== 'about'}
				<BookScope
					bind:this={bookScope}
					{groups}
					{info}
					thumbs={data.thumbs}
					selected={selected.path}
					index={selectedIndex}
					total={pages.length}
					title={titleOf(selected.path)}
					prev={pages[selectedIndex - 1]?.path ?? null}
					next={pages[selectedIndex + 1]?.path ?? null}
					bind:scope
					href={pageHref}
					onpick={selectOn(tab)}
					icons={data.icons}
				/>
			{/if}
			<div role="tabpanel" id="panel-overview" aria-labelledby="tab-overview" hidden={tab !== 'overview'}>
				{#if shows('overview')}
					<OverviewTab
						print={p}
						analysis={a}
						shot={data.shot}
						{single}
						summary={single && !produced ? describePrint(a) : null}
						main={products.main}
						more={produced - products.main.length}
						{tags}
						{preview}
						descriptionHtml={data.descriptionHtml}
						descriptionLong={data.descriptionLong}
						activeRole={filter?.kind === 'role' ? filter.role : null}
						onrole={single ? undefined : pickRole}
						ontab={openTab}
						icons={data.icons}
					/>
				{/if}
			</div>

			<div role="tabpanel" id="panel-pages" aria-labelledby="tab-pages" hidden={tab !== 'pages'} class="space-y-6">
				{#if shows('pages')}
					{#if single}
						<SelectedPage
							page={single}
							index={0}
							total={1}
							printId={p.id}
							rendered={rendered.has(single.path)}
							live={tab === 'pages'}
							prev={null}
							next={null}
							href={pageHref}
							onselect={select}
							copyLabel=""
							icons={data.icons}
						/>
					{:else if selected}
						<PagesSection
							{pages}
							books={a.nodes.filter((n) => n.kind === 'blueprint_book')}
							rootTitle={root ? pageTitle(root).text : title}
							selected={selected.path}
							href={pageHref}
							onselect={selectPage}
							{filter}
							onclearfilter={() => (filter = null)}
							roles={a.roles}
							onrole={pickRole}
							thumbs={data.thumbs}
							icons={data.icons}
						>
							<SelectedPage
								page={selected}
								index={selectedIndex}
								total={pages.length}
								printId={p.id}
								rendered={rendered.has(selected.path)}
								live={tab === 'pages'}
								prev={pages[selectedIndex - 1]?.path ?? null}
								next={pages[selectedIndex + 1]?.path ?? null}
								href={pageHref}
								onselect={selectPage}
								copyLabel={copyLabel(copied.page, 'Copy this page')}
								oncopy={() => copy('page')}
								icons={data.icons}
							/>
						</PagesSection>
					{/if}
				{/if}
			</div>

			{#if produced}
				<div role="tabpanel" id="panel-produces" aria-labelledby="tab-produces" hidden={tab !== 'produces'}>
					{#if shows('produces')}
						<ProducesTab
							main={scopedProducts.main}
							groups={scopedProducts.groups}
							sections={data.sections}
							order={data.menuOrder}
							intermediates={scopedInside}
							byQuality={(scoped ?? a).productsByQuality}
							empty={scoped ? `This page makes nothing: ${describeNode(scoped)}.` : null}
							onpick={single ? undefined : findPages}
							icons={data.icons}
						/>
					{/if}
				</div>
			{/if}

			{#if a.inputs.length}
				<div role="tabpanel" id="panel-inputs" aria-labelledby="tab-inputs" hidden={tab !== 'inputs'}>
					{#if shows('inputs')}
						<InputsTab
							inputs={scoped ? scoped.inputs : a.inputs}
							pages={scoped ? [scoped] : pages}
							single={scoped ?? single}
							onpick={single ? undefined : findPages}
							icons={data.icons}
						/>
					{/if}
				</div>
			{/if}

			<div role="tabpanel" id="panel-entities" aria-labelledby="tab-entities" hidden={tab !== 'entities'}>
				{#if shows('entities')}
					<EntitiesTab analysis={a} page={scoped} inBook={!single} icons={data.icons} />
				{/if}
			</div>

			{#if Object.keys(a.recipes).length}
				<div role="tabpanel" id="panel-recipes" aria-labelledby="tab-recipes" hidden={tab !== 'recipes'}>
					{#if shows('recipes')}
						<RecipesTab
							recipes={scoped ? scoped.recipes : a.recipes}
							info={data.recipes}
							pages={scoped ? [scoped] : pages}
							single={scoped ?? single}
							icons={data.icons}
						/>
					{/if}
				</div>
			{/if}

			<div role="tabpanel" id="panel-about" aria-labelledby="tab-about" hidden={tab !== 'about'}>
				{#if shows('about')}
					<AboutTab print={p} analysis={a} {root} shot={data.shot} icons={data.icons} />
				{/if}
			</div>
		</div>
	</div>

	<PrintSidebar
		print={p}
		analysis={a}
		size={single?.width && single.height ? `${single.width}×${single.height} tiles` : null}
		landings={data.landings}
		icons={data.icons}
	/>
</div>
