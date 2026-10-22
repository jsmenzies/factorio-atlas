<script lang="ts">
	import { goto } from '$app/navigation';
	import { page as route } from '$app/state';
	import InlineViewer from '#lib/components/InlineViewer.svelte';
	import MakesStrip from '#lib/components/MakesStrip.svelte';
	import Description from '#lib/components/print/Description.svelte';
	import InfraCards from '#lib/components/print/InfraCards.svelte';
	import PageDetail from '#lib/components/print/PageDetail.svelte';
	import PagesSection, { type PageFilter } from '#lib/components/print/PagesSection.svelte';
	import PrintHeader from '#lib/components/print/PrintHeader.svelte';
	import PrintSidebar from '#lib/components/print/PrintSidebar.svelte';
	import SelectedPage from '#lib/components/print/SelectedPage.svelte';
	import { bookProducts, describeBook, describePrint, infraCards } from '#lib/describe.js';
	import { plainText } from '#lib/richtext.js';
	import type { Role } from '#lib/server/pipeline/analyze.js';
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
	const title = $derived(String(p.title));
	// Author tags that add something to our analysis.
	const tags = $derived(usefulTags(p.tags, a.mods));

	// Finding a page in a big book: by what it makes (click a product) or its role (click a role chip).
	let filter = $state<PageFilter>(null);
	const pickItem = (signal: string) => (filter = filter?.kind === 'item' && filter.signal === signal ? null : { kind: 'item', signal });
	const pickRole = (role: Role) => (filter = filter?.kind === 'role' && filter.role === role ? null : { kind: 'role', role });

	// The selected book page lives in the URL (`?page=3/1`) so links land on it. Picking one is a
	// shallow navigation: the URL changes (page.shallow.url) but no load runs and the data stays.
	const selected = $derived.by(() => {
		const want = (route.shallow?.url ?? route.url).searchParams.get('page');
		return pages.find((n) => n.path === want) ?? pages[0] ?? null;
	});
	const selectedIndex = $derived(selected ? pages.indexOf(selected) : -1);
	// Pages without a game render get no viewer.
	const rendered = $derived(new Set(data.rendered));
	const select = (path: string) => goto(`?page=${encodeURIComponent(path)}`, { shallow: true, replace: true });
	const step = (by: number) => {
		const next = pages[selectedIndex + by];
		if (next) select(next.path);
	};

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

<svelte:head><title>{plainText(title)} · Blueprint Atlas</title></svelte:head>

<a href="/" class="text-sm text-stone-400 hover:text-amber-300">← Search</a>

<div class="mt-3 grid gap-8 lg:grid-cols-[1fr_20rem]">
	<div class="min-w-0 space-y-6">
		<PrintHeader
			print={p}
			{title}
			{root}
			roles={a.roles}
			{tags}
			single={!!single}
			activeRole={filter?.kind === 'role' ? filter.role : null}
			onrole={pickRole}
			copyLabel={bookCopyLabel}
			oncopy={() => copy('book')}
			icons={data.icons}
		/>

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
				{#if rendered.has(single.path)}<InlineViewer printId={p.id} path={single.path} />{/if}
				<PageDetail page={single} icons={data.icons} />
			</section>
		{:else if selected}
			<SelectedPage
				page={selected}
				index={selectedIndex}
				total={pages.length}
				printId={p.id}
				rendered={rendered.has(selected.path)}
				onstep={step}
				copyLabel={copyLabel(copied.page, 'Copy this page')}
				oncopy={() => copy('page')}
				icons={data.icons}
			/>
			<PagesSection {pages} {books} selected={selected.path} onselect={select} {filter} onclearfilter={() => (filter = null)} icons={data.icons} />
		{/if}

		{#if data.descriptionHtml}
			<Description html={data.descriptionHtml} long={String(p.description_md ?? '').length > 900} />
		{/if}

		{#if cards.length}
			<InfraCards {cards} byCategory={a.byCategory} heading={!single} icons={data.icons} />
		{/if}
	</div>

	<PrintSidebar print={p} analysis={a} main={products.main} title={plainText(title)} copyLabel={bookCopyLabel} oncopy={() => copy('book')} icons={data.icons} />
</div>
