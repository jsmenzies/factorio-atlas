<script lang="ts">
	import InlineViewer from '#lib/components/InlineViewer.svelte';
	import RichText from '#lib/components/RichText.svelte';
	import { pageTitle } from '#lib/describe.js';
	import type { IconSet } from '#lib/icons.js';
	import { plainClick } from '#lib/links.js';
	import type { NodeAnalysis } from '#lib/server/pipeline/analyze.js';
	import PageDetail from './PageDetail.svelte';

	/**
	 * The page being looked at, as one card: a bar with ‹ › to step (in a book), where it is and its
	 * title, Copy this page and Full screen; its render; then its facts.
	 */
	let {
		page,
		index,
		total,
		stepper = true,
		printId,
		rendered,
		live,
		prev,
		next,
		href,
		onselect,
		copyLabel,
		oncopy,
		icons
	}: {
		page: NodeAnalysis;
		index: number;
		total: number;
		/** Its own ‹ ›; off when a page bar above steps through the book. */
		stepper?: boolean;
		printId: string;
		/** Whether the page has a game render (else there's no viewer). */
		rendered: boolean;
		/** Whether to mount the viewer, which fetches its data: only while its tab is open. */
		live: boolean;
		/** The previous and next pages' paths, null at either end. ‹ › are links, so a crawler can walk the whole book. */
		prev: string | null;
		next: string | null;
		href: (path: string) => string;
		/** Picks a page in place (a plain click); other clicks follow the link. */
		onselect: (path: string) => void;
		copyLabel: string;
		/** Copies just this page; left out for a single blueprint, which the header copies. */
		oncopy?: () => void;
		icons: IconSet;
	} = $props();

	const t = $derived(pageTitle(page));
	const where = $derived(
		[
			total > 1 ? `Page ${index + 1} of ${total}` : null,
			page.width && page.height ? `${page.width}×${page.height} tiles` : null,
			`${page.entityCount.toLocaleString()} entities`
		]
			.filter(Boolean)
			.join(' · ')
	);
	const fullScreen = $derived(`/prints/${printId}/render?page=${encodeURIComponent(page.path)}`);
	const BUTTON = 'grid size-10 shrink-0 place-items-center rounded-md bg-stone-800 text-stone-200';
</script>

<section class="overflow-hidden rounded-xl border border-stone-800 bg-stone-900/40" aria-label="Selected page">
	<div class="flex flex-wrap items-center gap-3 border-b border-stone-800 px-4 py-3">
		{#if total > 1 && stepper}
			<div class="flex gap-1.5">
				{#each [{ path: prev, label: 'Previous page', arrow: '‹' }, { path: next, label: 'Next page', arrow: '›' }] as step (step.label)}
					{#if step.path === null}
						<span class="{BUTTON} opacity-40" aria-hidden="true">{step.arrow}</span>
					{:else}
						{@const path = step.path}
						<a
							href={href(path)}
							onclick={(e) => {
								if (!plainClick(e)) return;
								e.preventDefault();
								onselect(path);
							}}
							class="{BUTTON} hover:bg-stone-700 hover:text-amber-300"
							aria-label={step.label}>{step.arrow}</a
						>
					{/if}
				{/each}
			</div>
		{/if}
		<div class="min-w-0 flex-1">
			<p class="truncate text-sm text-stone-400">{where}</p>
			<h3 class="truncate text-lg font-semibold {t.derived ? 'text-stone-300 italic' : 'text-stone-50'}">
				<RichText text={t.text} {icons} size={20} />
			</h3>
		</div>
		<div class="flex gap-2">
			{#if oncopy}
				<button
					onclick={oncopy}
					class="rounded-md border border-amber-500/70 px-3.5 py-2 text-sm font-medium text-amber-300 hover:bg-amber-500/10"
					title="Copy just this page as its own blueprint">{copyLabel}</button
				>
			{/if}
			{#if rendered}
				<a href={fullScreen} class="rounded-md border border-stone-700 px-3.5 py-2 text-sm text-stone-200 hover:border-stone-500 hover:text-amber-300">Full screen ↗</a>
			{/if}
		</div>
	</div>
	{#if rendered}
		{#if live}<InlineViewer {printId} path={page.path} />{:else}<div class="h-[30rem] bg-stone-950"></div>{/if}
	{/if}
	<div class="px-4 py-3 {rendered ? 'border-t border-stone-800' : ''}">
		<PageDetail {page} {icons} />
	</div>
</section>
