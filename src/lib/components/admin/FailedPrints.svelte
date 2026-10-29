<script lang="ts">
	import { page } from '$app/state';
	import { sourceUrl } from '#lib/format.js';
	import type { FailedPrint } from '#lib/server/admin/pipeline.js';
	import { clock, int } from './metrics.js';

	let {
		failed,
		now,
		timeZone
	}: {
		failed: { items: FailedPrint[]; total: number; page: number; pages: number; perPage: number };
		now: number;
		timeZone?: string;
	} = $props();

	const pageHref = (n: number) => {
		const url = new URL(page.url.href);
		if (n <= 1) url.searchParams.delete('failed');
		else url.searchParams.set('failed', String(n));
		return `${url.pathname}${url.search}#failed`;
	};
	const first = $derived((failed.page - 1) * failed.perPage + 1);
	const last = $derived(Math.min(failed.total, failed.page * failed.perPage));
</script>

<section id="failed" class="space-y-3">
	<div class="flex flex-wrap items-baseline justify-between gap-2">
		<h2 class="text-lg font-semibold text-stone-100">Failed prints <span class="font-normal text-stone-500">· {int(failed.total)}</span></h2>
		{#if failed.total > failed.perPage}
			<p class="text-sm text-stone-500">{int(first)}–{int(last)} of {int(failed.total)}</p>
		{/if}
	</div>
	{#if failed.items.length === 0}
		<p class="text-sm text-stone-500">No prints failed in this run.</p>
	{:else}
		<ul class="divide-y divide-stone-800 rounded-lg border border-stone-800 bg-stone-900/50">
			{#each failed.items as f (f.id)}
				<li class="grid gap-x-4 gap-y-1 px-3 py-2 text-sm sm:grid-cols-[16rem_1fr_auto] sm:items-baseline">
					<span class="flex items-baseline gap-2 whitespace-nowrap">
						{#if f.onSite}
							<a href="/prints/{f.id}" class="font-mono text-amber-400 hover:text-amber-300" title="Our page (an earlier version)">{f.id}</a>
						{:else}
							<span class="font-mono text-stone-300">{f.id}</span>
						{/if}
						{#if sourceUrl(f.id)}
							<a href={sourceUrl(f.id)} rel="external noopener" target="_blank" class="text-xs text-stone-500 hover:text-amber-300">original ↗</a>
						{/if}
					</span>
					<span class="line-clamp-2 break-words text-rose-200/90" title={f.reason ?? ''}>{f.reason ?? 'no reason recorded'}</span>
					<span class="text-xs text-stone-500 tabular-nums">{clock(f.checkedAt, now, timeZone)}</span>
				</li>
			{/each}
		</ul>
		{#if failed.pages > 1}
			<nav class="flex items-center gap-3 text-sm" aria-label="Failed prints pages">
				{#if failed.page > 1}<a href={pageHref(failed.page - 1)} class="text-amber-400 hover:text-amber-300">← Newer</a>{/if}
				<span class="text-stone-500">Page {failed.page} of {failed.pages}</span>
				{#if failed.page < failed.pages}<a href={pageHref(failed.page + 1)} class="text-amber-400 hover:text-amber-300">Older →</a>{/if}
			</nav>
		{/if}
	{/if}
</section>
