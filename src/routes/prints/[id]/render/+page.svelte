<script lang="ts">
	import { goto } from '$app/navigation';
	import BlueprintIcons from '#lib/components/BlueprintIcons.svelte';
	import BlueprintViewer from '#lib/components/BlueprintViewer.svelte';
	import Lightbox from '#lib/components/Lightbox.svelte';
	import PageMeta from '#lib/components/PageMeta.svelte';
	import RichText from '#lib/components/RichText.svelte';
	import { plainText } from '#lib/richtext.js';
	import { formatRate, imgurUrl, signalName } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const p = $derived(data.print);
	const page = $derived(data.page);
	const blueprints = $derived(data.pages.filter((n) => n.kind === 'blueprint'));

	const select = (path: string) => goto(`?page=${encodeURIComponent(path)}`, { reset: false });
	const index = $derived(blueprints.findIndex((n) => n.path === data.path));
	const step = (by: number) => {
		const next = blueprints[index + by];
		if (next) select(next.path);
	};
	// Untitled pages are named from their icons ("#1 · Assembling machine 2 · Electronic circuit").
	const titleOf = (path: string, label: string | null) => plainText(data.info[path]?.title.text ?? label ?? 'Untitled');
	const optionLabel = (n: (typeof data.pages)[number]) => {
		const indent = '  '.repeat(Math.max(0, n.depth - 1));
		if (n.kind !== 'blueprint') return `${indent}${titleOf(n.path, n.label)}`;
		const summary = data.info[n.path]?.summary;
		return `${indent}${Number(n.path.split('/').at(-1)) + 1}. ${titleOf(n.path, n.label)}${summary ? ` — ${summary}` : ''}`;
	};
	const here = $derived(data.path !== null ? data.info[data.path] : undefined);
	const book = $derived(blueprints.length > 1);

	// Back to the print, on the same book page (the first page is the print's own URL).
	const back = $derived(
		data.path === null || data.path === blueprints[0]?.path ? `/prints/${p.id}` : `/prints/${p.id}?page=${encodeURIComponent(data.path)}`
	);

	let infoOpen = $state(false);
	const exit = () => {
		if (infoOpen) infoOpen = false;
		else goto(back);
	};

	let lightbox = $state<Lightbox>();

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

<!-- The print page is the one to index; this full-screen view repeats it with less text. -->
<PageMeta
	title="Render · {plainText(p.title)} · Blueprint Atlas"
	description="Full-screen game render of {plainText(p.title)}, a Factorio blueprint."
	noindex
	image={p.image_id ? { url: imgurUrl(p.image_id, p.image_type, 'preview'), alt: `Screenshot of ${plainText(p.title)}` } : undefined}
/>

<svelte:window
	onpointerdown={(e) => {
		if (infoOpen && !(e.target instanceof Element && e.target.closest('[data-info]'))) infoOpen = false;
	}}
	onkeydown={(e) => {
		// Without a render there is no viewer to take Esc.
		if (e.key === 'Escape' && !data.render && !document.querySelector('dialog[open]')) exit();
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
			<!-- What this is: back, the page's in-game icons, the title, and what it makes and how big it is. -->
			<header
				class="pointer-events-auto relative flex max-w-full min-w-0 items-center gap-3 rounded-xl border border-stone-700 bg-stone-900/90 p-2 pr-3 shadow-lg backdrop-blur sm:max-w-xl"
			>
				<a href={back} class="shrink-0 rounded-lg border border-stone-700 bg-stone-800 px-3 py-1.5 text-sm text-stone-200 hover:bg-stone-700"
					>← Back</a
				>
				{#if here?.icons.length}
					<span class="hidden shrink-0 rounded-md bg-stone-950/60 p-0.5 sm:block"><BlueprintIcons icons={data.icons} signals={here.icons} size={36} /></span>
				{/if}
				<div class="min-w-0 flex-1">
					<h1 class="truncate font-semibold text-stone-100" title={plainText(p.title)}>
						<RichText text={p.title} icons={data.icons} size={18} />
					</h1>
					{#if here}
						<p class="truncate text-xs text-stone-400">
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
						</p>
					{/if}
					{#if book}
						<div class="mt-1 flex items-center gap-1 text-xs">
							<button
								class="rounded bg-stone-800 px-2 py-0.5 hover:bg-stone-700 disabled:opacity-40"
								disabled={index <= 0}
								onclick={() => step(-1)}
								aria-label="Previous page">‹</button
							>
							<select
								class="min-w-0 flex-1 truncate rounded border border-stone-700 bg-stone-950 px-2 py-0.5"
								value={data.path ?? ''}
								onchange={(e) => select(e.currentTarget.value)}
								aria-label="Book page"
							>
								{#each data.pages as n, i (i)}
									<option value={n.path} disabled={n.kind !== 'blueprint'}>{optionLabel(n)}</option>
								{/each}
							</select>
							<button
								class="rounded bg-stone-800 px-2 py-0.5 hover:bg-stone-700 disabled:opacity-40"
								disabled={index >= blueprints.length - 1}
								onclick={() => step(1)}
								aria-label="Next page">›</button
							>
							<span class="shrink-0 text-stone-500 tabular-nums">{index + 1} / {blueprints.length}</span>
						</div>
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
							class="absolute top-full right-0 left-0 z-10 mt-2 space-y-1.5 rounded-xl border border-stone-700 bg-stone-900/95 p-3 text-xs shadow-lg backdrop-blur"
						>
							{#if book}
								<p class="font-medium {here.title.derived ? 'text-stone-300 italic' : 'text-stone-100'}">
									<RichText text={here.title.text ?? here.label ?? 'Untitled'} icons={data.icons} size={14} />
								</p>
							{/if}
							{#if here.summary}<p class="text-stone-300">{here.summary}</p>{/if}
							{#if here.setup}<p class="text-stone-400">{here.setup}</p>{/if}
							<p class="text-stone-500">
								{[p.author_name && `By ${p.author_name}`, here.gameVersion && `Saved in Factorio ${here.gameVersion}`].filter(Boolean).join(' · ')}
							</p>
						</div>
					{/if}
				{/if}
			</header>

			<div class="pointer-events-auto flex shrink-0 gap-2">
				{#if p.image_id}
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

{#if p.image_id}
	<Lightbox bind:this={lightbox} label="Screenshot of {plainText(p.title)}">
		<img
			referrerpolicy="no-referrer"
			src={imgurUrl(p.image_id, p.image_type, 'original')}
			alt="Screenshot of {plainText(p.title)}"
			class="mx-auto block max-h-[calc(95vh-3rem)] max-w-[95vw] object-contain"
		/>
	</Lightbox>
{/if}
