<script lang="ts">
	import { goto } from '$app/navigation';
	import { page as route } from '$app/state';
	import BlueprintIcons from '#lib/components/BlueprintIcons.svelte';
	import BlueprintViewer from '#lib/components/BlueprintViewer.svelte';
	import PageMeta from '#lib/components/PageMeta.svelte';
	import PagePicker from '#lib/components/PagePicker.svelte';
	import RichText from '#lib/components/RichText.svelte';
	import ShotLightbox from '#lib/components/ShotLightbox.svelte';
	import { groupPages } from '#lib/book-groups.js';
	import { plainText } from '#lib/richtext.js';
	import { formatRate, signalName } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const p = $derived(data.print);
	const page = $derived(data.page);
	const blueprints = $derived(data.pages.filter((n) => n.kind === 'blueprint'));

	// Opened from the print's Overview (`&from=overview`), else its Render & pages tab: Back returns there.
	const fromOverview = $derived(route.url.searchParams.get('from') === 'overview');
	const pageQuery = (path: string) => `?page=${encodeURIComponent(path)}${fromOverview ? '&from=overview' : ''}`;
	const select = (path: string) => goto(pageQuery(path), { reset: false });
	const index = $derived(blueprints.findIndex((n) => n.path === data.path));
	const step = (by: number) => {
		const next = blueprints[index + by];
		if (next) select(next.path);
	};
	// Untitled pages are named from their icons ("#1 · Assembling machine 2 · Electronic circuit").
	const titleOf = (path: string) => plainText(data.info[path]?.title.text ?? data.info[path]?.label ?? 'Untitled');
	const groups = $derived(groupPages(data.pages, titleOf));
	const here = $derived(data.path !== null ? data.info[data.path] : undefined);
	const book = $derived(blueprints.length > 1);

	// Back to the print, on the same book page and the tab it came from. The first page is the
	// print's own URL, which opens on the Overview; any other page's opens on Render & pages.
	const back = $derived.by(() => {
		if (data.path === null) return `/prints/${p.id}`;
		if (data.path === blueprints[0]?.path) return fromOverview ? `/prints/${p.id}` : `/prints/${p.id}?tab=pages`;
		return `/prints/${p.id}?page=${encodeURIComponent(data.path)}${fromOverview ? '&tab=overview' : ''}`;
	});

	let infoOpen = $state(false);
	let pickerOpen = $state(false);
	// Esc closes what's open first, then leaves.
	const exit = () => {
		if (pickerOpen) pickerOpen = false;
		else if (infoOpen) infoOpen = false;
		else goto(back);
	};
	const stepButton =
		'grid size-9 place-items-center rounded-lg border border-stone-700 bg-stone-800 text-stone-200 hover:bg-stone-700 disabled:opacity-40 disabled:hover:bg-stone-800';

	let lightbox = $state<ShotLightbox>();

	// A book copies just the page on screen; a single blueprint copies the print's own string.
	type CopyState = 'idle' | 'copying' | 'done' | 'failed';
	let copied = $state<CopyState>('idle');
	const copy = async () => {
		copied = 'copying';
		try {
			const query = book && data.path !== null ? `?page=${encodeURIComponent(data.path)}` : '';
			const res = await fetch(`/prints/${p.id}/string${query}`);
			if (!res.ok) throw new Error(String(res.status));
			await navigator.clipboard.writeText(await res.text());
			copied = 'done';
		} catch {
			copied = 'failed';
		}
		setTimeout(() => (copied = 'idle'), 2000);
	};
	const copyLabel = $derived({ idle: 'Copy string', copying: 'Copying…', done: 'Copied!', failed: 'Copy failed' }[copied]);
</script>

{#snippet chevron(d: string)}
	<svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
		><path {d} /></svg
	>
{/snippet}

{#snippet stats(here: NonNullable<typeof data.info[string]>)}
	{#if here.makes}
		<span class="font-mono text-emerald-300" title={here.makes.claimed ? 'Rate given by the author' : 'Nameplate estimate'}
			>{here.makes.claimed ? '' : '≈ '}{formatRate(here.makes.rate)}</span
		>
		{signalName(here.makes.signal).toLowerCase()}{here.makes.more ? ` +${here.makes.more}` : ''}
	{:else if here.summary}
		{here.summary}
	{/if}
	{[here.size, here.entities != null && `${here.entities.toLocaleString()} entities`]
		.filter(Boolean)
		.map((part) => ` · ${part}`)
		.join('')}
	{#if here.gameVersion}· <span title="Saved in Factorio {here.gameVersion}">{here.gameVersion}</span>{/if}
{/snippet}

<!-- The print page is the one to index; this full-screen view repeats it with less text. -->
<PageMeta
	title="Render · {plainText(p.title)} · Blueprint Atlas"
	description="Full-screen game render of {plainText(p.title)}, a Factorio blueprint."
	noindex
	image={data.shot.og ? { ...data.shot.og, alt: `Screenshot of ${plainText(p.title)}` } : undefined}
/>

<svelte:window
	onpointerdown={(e) => {
		const inside = (sel: string) => e.target instanceof Element && !!e.target.closest(sel);
		if (infoOpen && !inside('[data-info]')) infoOpen = false;
		if (pickerOpen && !inside('[data-picker]')) pickerOpen = false;
	}}
	onkeydown={(e) => {
		// Without a render there is no viewer to take Esc.
		if (e.key === 'Escape' && !e.defaultPrevented && !data.render && !document.querySelector('dialog[open]')) exit();
	}}
/>

<div class="fixed inset-0 z-20 bg-stone-950 p-2 text-stone-200 sm:p-5">
	<div class="relative h-full overflow-hidden rounded-xl border border-stone-800 bg-stone-950">
		{#if page && data.render}
			<svelte:boundary onerror={(e) => console.error('viewer failed:', e)}>
				<BlueprintViewer {page} render={{ sidecar: data.render, base: data.base }} tooltip={data.tooltip} full onexit={exit} />
				{#snippet failed()}
					<p class="grid h-full place-items-center text-stone-400">Could not show this render.</p>
				{/snippet}
			</svelte:boundary>
		{:else}
			<p class="grid h-full place-items-center text-stone-400">
				{data.path !== null ? 'This page has no render yet.' : 'This print has no blueprint pages to draw.'}
			</p>
		{/if}

		<div class="pointer-events-none absolute inset-x-3 top-3 flex flex-wrap items-start justify-between gap-2 sm:inset-x-5 sm:top-5">
			<!-- What this is: back, the title, and what it makes and how big it is; a book's page stepper and picker. -->
			<header
				class="pointer-events-auto relative z-10 flex max-w-full min-w-0 items-center gap-2 rounded-xl border border-stone-700 bg-stone-900/90 p-2 shadow-lg backdrop-blur sm:gap-3 {book
					? 'flex-wrap sm:max-w-3xl sm:flex-nowrap'
					: 'pr-3 sm:max-w-xl'}"
			>
				<a href={back} class="shrink-0 rounded-lg border border-stone-700 bg-stone-800 px-3 py-1.5 text-sm text-stone-200 hover:bg-stone-700"
					>← Back</a
				>
				{#if !book && here?.icons.length}
					<span class="hidden shrink-0 rounded-md bg-stone-950/60 p-0.5 sm:block"><BlueprintIcons icons={data.icons} signals={here.icons} size={36} /></span>
				{/if}
				<div class="min-w-0 flex-1">
					{#if book}
						<h1 class="min-w-0">
							<span class="block truncate text-xs text-stone-400" title={plainText(p.title)}><RichText text={p.title} icons={data.icons} size={14} /></span>
							<span
								class="block truncate font-semibold {here?.title.derived ? 'text-stone-300 italic' : 'text-stone-100'}"
								title={here?.title.derived ? 'Untitled page, named from its icons' : undefined}
							>
								<RichText text={here?.title.text ?? here?.label ?? 'Untitled'} icons={data.icons} size={18} />
							</span>
						</h1>
					{:else}
						<h1 class="truncate font-semibold text-stone-100" title={plainText(p.title)}>
							<RichText text={p.title} icons={data.icons} size={18} />
						</h1>
						{#if here}<p class="truncate text-xs text-stone-400">{@render stats(here)}</p>{/if}
					{/if}
				</div>
				{#if here}
					<button
						data-info
						class="shrink-0 self-start rounded-full p-0.5 text-stone-500 hover:text-stone-200 aria-expanded:text-amber-300"
						aria-expanded={infoOpen}
						aria-controls="page-info"
						aria-label="About this page"
						title="About this page"
						onclick={() => (infoOpen = !infoOpen)}
					>
						<svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
							<circle cx="8" cy="8" r="6.5" />
							<path d="M8 7.2v4" stroke-linecap="round" />
							<circle cx="8" cy="4.9" r="0.8" fill="currentColor" stroke="none" />
						</svg>
					</button>
					{#if infoOpen}
						<div
							id="page-info"
							data-info
							class="absolute top-full left-0 z-10 mt-2 w-full max-w-xl space-y-1.5 rounded-xl border border-stone-700 bg-stone-900/95 p-3 text-xs shadow-lg backdrop-blur"
						>
							{#if book}<p class="text-stone-300">{@render stats(here)}</p>{/if}
							{#if here.summary}<p class="text-stone-300">{here.summary}</p>{/if}
							{#if here.setup}<p class="text-stone-400">{here.setup}</p>{/if}
							<p class="text-stone-500">
								{[p.author_name && `By ${p.author_name}`, here.gameVersion && `Saved in Factorio ${here.gameVersion}`].filter(Boolean).join(' · ')}
							</p>
						</div>
					{/if}
				{/if}
				{#if book}
					<span class="mx-1 hidden h-8 w-px shrink-0 bg-stone-700 sm:block"></span>
					<!-- On phones the stepper takes its own row, so the titles keep their width. -->
					<div class="flex w-full shrink-0 items-center gap-1.5 sm:w-auto" data-picker>
						<button class={stepButton} disabled={index <= 0} onclick={() => step(-1)} aria-label="Previous page" title="Previous page"
							>{@render chevron('M10.25 3.5 5.75 8l4.5 4.5')}</button
						>
						<button
							class="flex h-9 flex-1 items-center justify-center gap-2 rounded-lg border px-3 text-sm transition sm:flex-none {pickerOpen
								? 'border-amber-500/70 bg-amber-500/10 text-amber-200'
								: 'border-stone-700 bg-stone-800 text-stone-200 hover:bg-stone-700'}"
							aria-expanded={pickerOpen}
							aria-haspopup="dialog"
							aria-label="Page {index + 1} of {blueprints.length}: all pages"
							onclick={() => (pickerOpen = !pickerOpen)}
						>
							<span class="font-mono tabular-nums">{index + 1} / {blueprints.length}</span>
							<span class="text-stone-400">Pages</span>
							<span class="text-[0.6rem] text-stone-400" aria-hidden="true">▼</span>
						</button>
						<button
							class={stepButton}
							disabled={index >= blueprints.length - 1}
							onclick={() => step(1)}
							aria-label="Next page"
							title="Next page">{@render chevron('M5.75 3.5 10.25 8 5.75 12.5')}</button>
					</div>
					{#if pickerOpen}
						<div class="absolute top-full left-0 z-10 mt-2" data-picker>
							<PagePicker
								{groups}
								current={data.path}
								pages={data.info}
								thumbs={data.thumbs}
								icons={data.icons}
								href={pageQuery}
								onpick={(path) => {
									pickerOpen = false;
									select(path);
								}}
								onclose={() => (pickerOpen = false)}
							/>
						</div>
					{/if}
				{/if}
			</header>

			<div class="pointer-events-auto flex shrink-0 gap-2">
				{#if data.shot.large}
					<button
						class="rounded-lg border border-stone-700 bg-stone-900/90 px-3 py-1.5 text-sm text-stone-200 shadow-lg backdrop-blur hover:bg-stone-800"
						onclick={() => lightbox?.open()}>Author's screenshot</button
					>
				{/if}
				<button
					class="rounded-lg bg-amber-500 px-3.5 py-1.5 text-sm font-semibold text-stone-950 shadow-lg hover:bg-amber-400"
					title={book ? 'Copy just this page as its own blueprint' : 'Copy the blueprint string'}
					onclick={copy}>{copyLabel}</button
				>
			</div>
		</div>
	</div>
</div>

{#if data.shot.large && data.shot.full}
	<ShotLightbox bind:this={lightbox} large={data.shot.large} full={data.shot.full} title={plainText(p.title)} imgur={data.shot.imgur} />
{/if}
