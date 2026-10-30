<script lang="ts">
	import { sourceUrl } from '#lib/sources.js';
	import type { JobPage } from '#lib/server/admin/render.js';
	import { plainText } from '#lib/richtext.js';
	import { clock, duration, int } from '../metrics.js';
	import { pageName, printHref } from './metrics.js';
	import Pager from './Pager.svelte';

	/** Failed, skipped or in-flight pages with their reason (or how long they've been going). */
	let {
		jobs,
		kind,
		now,
		timeZone,
		scope = ''
	}: { jobs: JobPage; kind: 'failed' | 'skipped' | 'rendering'; now: number; timeZone?: string; scope?: string } = $props();

	const TEXT = {
		failed: { id: 'failed', title: 'Failed pages', empty: 'No page has failed.', reason: 'text-rose-200/90' },
		skipped: { id: 'skipped', title: 'Skipped pages', empty: 'No page was skipped.', reason: 'text-amber-200/80' },
		rendering: { id: 'in-flight', title: 'Rendering now', empty: 'Nothing is rendering.', reason: 'text-stone-400' }
	};
	const t = $derived(TEXT[kind]);
	const first = $derived((jobs.page - 1) * jobs.perPage + 1);
	const last = $derived(Math.min(jobs.total, jobs.page * jobs.perPage));
</script>

<section id={t.id} class="space-y-3">
	<div class="flex flex-wrap items-baseline justify-between gap-2">
		<h2 class="text-lg font-semibold text-stone-100">{t.title} <span class="font-normal text-stone-500">· {int(jobs.total)}{scope ? ` ${scope}` : ''}</span></h2>
		{#if jobs.total > jobs.perPage}
			<p class="text-sm text-stone-500">
				{#if kind === 'rendering'}showing {int(jobs.items.length)}{:else}{int(first)}–{int(last)} of {int(jobs.total)}{/if}
			</p>
		{/if}
	</div>
	{#if jobs.items.length === 0}
		<p class="text-sm text-stone-500">{t.empty}</p>
	{:else}
		<ul class="divide-y divide-stone-800 rounded-lg border border-stone-800 bg-stone-900/50">
			{#each jobs.items as job (`${job.print_id}/${job.path}`)}
				{@const title = job.title ? plainText(job.title) : null}
				<li class="grid gap-x-4 gap-y-1 px-3 py-2 text-sm md:grid-cols-[minmax(14rem,1fr)_minmax(0,1.6fr)_5rem_7rem] md:items-baseline">
					<span class="min-w-0 space-y-0.5">
						<span class="flex items-baseline gap-2 whitespace-nowrap">
							{#if job.onSite}
								<a href={printHref(job)} class="font-mono text-amber-400 hover:text-amber-300" title="Print page">{job.print_id}</a>
							{:else}
								<span class="font-mono text-stone-300" title="Not in the local database">{job.print_id}</span>
							{/if}
							{#if sourceUrl(job.print_id)}
								<a href={sourceUrl(job.print_id)} rel="external noopener" target="_blank" class="text-xs text-stone-500 hover:text-amber-300"
									>original ↗</a
								>
							{/if}
						</span>
						<span class="block truncate text-xs text-stone-400" title={title ?? ''}>
							{pageName(job)}{#if title}<span class="text-stone-600">{' · '}</span>{title}{/if}
						</span>
					</span>
					{#if kind === 'rendering'}
						<span class="text-stone-400 tabular-nums">{int(job.entities)} entities{job.game_version ? ` · ${job.game_version}` : ''}</span>
						<span class="text-xs text-stone-500 tabular-nums" title="Attempts">{job.attempts > 1 ? `try ${job.attempts}` : ''}</span>
						<span class="text-xs text-stone-500 tabular-nums">{job.started_at ? `for ${duration(now - job.started_at)}` : ''}</span>
					{:else}
						<span class="line-clamp-2 font-mono text-xs break-words {t.reason}" title={job.reason ?? ''}>{job.reason ?? 'no reason recorded'}</span>
						<span class="text-xs text-stone-500 tabular-nums" title="Attempts">
							{#if kind === 'failed' || job.attempts > 0}{job.attempts} {job.attempts === 1 ? 'attempt' : 'attempts'}{/if}
						</span>
						<span class="text-xs text-stone-500 tabular-nums">{job.finished_at ? clock(job.finished_at, now, timeZone) : ''}</span>
					{/if}
				</li>
			{/each}
		</ul>
		{#if kind !== 'rendering'}
			<Pager param={kind} current={jobs.page} pages={jobs.pages} anchor={t.id} label={t.title} />
		{/if}
	{/if}
</section>
