<script lang="ts">
	import BlueprintIcons from '#lib/components/BlueprintIcons.svelte';
	import InlineViewer from '#lib/components/InlineViewer.svelte';
	import RichText from '#lib/components/RichText.svelte';
	import { describeNode, pageTitle } from '#lib/describe.js';
	import type { IconSet } from '#lib/icons.js';
	import type { NodeAnalysis } from '#lib/server/pipeline/analyze.js';
	import PageDetail from './PageDetail.svelte';

	/** The book page being looked at: ‹ › to step, its title, a copy button, its render and facts. */
	let {
		page,
		index,
		total,
		printId,
		rendered,
		onstep,
		copyLabel,
		oncopy,
		icons
	}: {
		page: NodeAnalysis;
		index: number;
		total: number;
		printId: string;
		/** Whether the page has a game render (else there's no viewer). */
		rendered: boolean;
		onstep: (by: number) => void;
		copyLabel: string;
		oncopy: () => void;
		icons: IconSet;
	} = $props();

	const t = $derived(pageTitle(page));
</script>

<section class="space-y-3 rounded-lg border border-stone-800 bg-stone-900/40 p-3" aria-label="Selected page">
	<div class="flex flex-wrap items-center gap-2">
		<div class="flex items-center gap-1">
			<button
				class="rounded bg-stone-800 px-2 py-0.5 hover:bg-stone-700 disabled:opacity-40"
				disabled={index <= 0}
				onclick={() => onstep(-1)}
				aria-label="Previous page">‹</button
			>
			<button
				class="rounded bg-stone-800 px-2 py-0.5 hover:bg-stone-700 disabled:opacity-40"
				disabled={index >= total - 1}
				onclick={() => onstep(1)}
				aria-label="Next page">›</button
			>
		</div>
		{#if page.icons.length}<BlueprintIcons {icons} signals={page.icons} size={36} />{/if}
		<div class="min-w-0 flex-1">
			<h3 class="truncate font-medium {t.derived ? 'text-stone-300 italic' : 'text-stone-100'}">
				<RichText text={t.text} {icons} size={18} />
			</h3>
			<p class="truncate text-xs text-stone-400">{index + 1} of {total} · {describeNode(page)}</p>
		</div>
		<button
			onclick={oncopy}
			class="rounded border border-amber-500/60 px-3 py-1 text-sm text-amber-300 hover:bg-amber-500/10"
			title="Copy just this page as its own blueprint">{copyLabel}</button
		>
	</div>
	{#if rendered}<InlineViewer {printId} path={page.path} />{/if}
	<PageDetail {page} {icons} />
</section>
