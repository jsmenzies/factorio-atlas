<script lang="ts">
	import { goto } from '$app/navigation';
	import BlueprintIcons from '#lib/components/BlueprintIcons.svelte';
	import BlueprintViewer from '#lib/components/BlueprintViewer.svelte';
	import RichText from '#lib/components/RichText.svelte';
	import { plainText } from '#lib/richtext.js';
	import { imgurUrl } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const p = $derived(data.print);
	const page = $derived(data.page);
	const blueprints = $derived(data.pages.filter((n) => n.kind === 'blueprint'));

	const select = (path: string) => goto(`?page=${encodeURIComponent(path)}`, { reset: false });
	const index = $derived(blueprints.findIndex((n) => n.path === page?.path));
	const step = (by: number) => {
		const next = blueprints[index + by];
		if (next) select(next.path);
	};
	// Untitled pages are named from their icons ("#1 · Assembling machine 2 · Electronic circuit").
	const titleOf = (path: string, label: string | null) => plainText(data.info[path]?.title.text ?? label ?? 'Untitled');
	const optionLabel = (n: (typeof data.pages)[number]) => {
		const indent = '\u00a0\u00a0'.repeat(Math.max(0, n.depth - 1));
		if (n.kind !== 'blueprint') return `${indent}${titleOf(n.path, n.label)}`;
		const summary = data.info[n.path]?.summary;
		return `${indent}${Number(n.path.split('/').at(-1)) + 1}. ${titleOf(n.path, n.label)}${summary ? ` — ${summary}` : ''}`;
	};
	const here = $derived(page ? data.info[page.path] : undefined);
</script>

<svelte:head><title>Render · {plainText(p.title)} · Blueprint Atlas</title></svelte:head>

<div class="fixed inset-0 z-20 flex flex-col bg-stone-950 text-stone-200">
	<header class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-stone-800 bg-stone-900 px-3 py-2 text-sm">
		<a href="/prints/{p.id}" class="text-stone-400 hover:text-amber-300">← back to print</a>
		<h1 class="min-w-0 truncate font-semibold text-stone-100" title={plainText(p.title)}><RichText text={p.title} icons={data.icons} size={18} /></h1>
		{#if blueprints.length > 1}
			<div class="flex items-center gap-1">
				<button class="rounded bg-stone-800 px-2 py-0.5 hover:bg-stone-700 disabled:opacity-40" disabled={index <= 0} onclick={() => step(-1)}
					>‹</button
				>
				<select
					class="max-w-[60vw] rounded border border-stone-700 bg-stone-950 px-2 py-0.5 text-xs sm:max-w-md"
					value={page?.path ?? ''}
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
					onclick={() => step(1)}>›</button
				>
				<span class="text-xs text-stone-500">{index + 1} / {blueprints.length}</span>
			</div>
		{/if}
		<span class="ml-auto flex items-center gap-3 text-xs text-stone-500">
			{#if p.image_id}
				<a class="underline hover:text-amber-300" href={imgurUrl(p.image_id, p.image_type, 'original')} target="_blank" rel="external noreferrer"
					>screenshot</a
				>
			{/if}
		</span>
	</header>
	{#if page}
		<!-- What this page is: its in-game icons, name, what it makes and how it's built. -->
		<div class="flex items-center gap-3 border-b border-stone-800 bg-stone-900/70 px-3 py-2 text-sm">
			{#if here?.icons.length}<BlueprintIcons icons={data.icons} signals={here.icons} size={40} />{/if}
			<div class="min-w-0">
				<p
					class="truncate font-medium {here?.title.derived ? 'text-stone-300 italic' : 'text-stone-100'}"
					title={here?.title.derived ? 'Untitled page, named from its icons' : undefined}
				>
					<RichText text={here?.title.text ?? page.label ?? 'Untitled'} icons={data.icons} size={16} />
				</p>
				<p class="truncate text-xs text-stone-400">
					{[here?.summary, here?.setup, here?.size, `${page.entities.length} entities`, page.gameVersion && `Factorio ${page.gameVersion}`]
						.filter(Boolean)
						.join(' · ')}
				</p>
			</div>
		</div>
	{/if}
	<div class="min-h-0 flex-1">
		{#if page}
			<BlueprintViewer {page} render={data.render ? { sidecar: data.render, base: `/prints/${p.id}/render` } : null} />
		{:else}
			<p class="p-6 text-stone-400">This print has no blueprint pages to draw.</p>
		{/if}
	</div>
</div>
