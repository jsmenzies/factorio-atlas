<script lang="ts">
	import type { JobPage } from '#lib/server/admin/render.js';
	import { plainText } from '#lib/richtext.js';
	import { bytes, clock, int } from '../metrics.js';
	import { ms, pageName, printHref, thumbUrl, viewerHref } from './metrics.js';
	import Pager from './Pager.svelte';

	/** Rendered pages, newest first, as thumbnails of their overview image. Click opens the full-screen viewer. */
	let { jobs, now, timeZone, scope = '' }: { jobs: JobPage; now: number; timeZone?: string; scope?: string } = $props();

	// Overviews that didn't load (not on disk, or a format the file route doesn't serve yet).
	let broken = $state<Record<string, boolean>>({});
	const first = $derived((jobs.page - 1) * jobs.perPage + 1);
	const last = $derived(Math.min(jobs.total, jobs.page * jobs.perPage));
</script>

<section id="rendered" class="space-y-3">
	<div class="flex flex-wrap items-baseline justify-between gap-2">
		<h2 class="text-lg font-semibold text-stone-100">
			Latest renders <span class="font-normal text-stone-500">· {int(jobs.total)}{scope ? ` ${scope}` : ''}</span>
		</h2>
		{#if jobs.total > jobs.perPage}
			<p class="text-sm text-stone-500">{int(first)}–{int(last)} of {int(jobs.total)}</p>
		{/if}
	</div>
	{#if jobs.items.length === 0}
		<p class="text-sm text-stone-500">No page has rendered yet.</p>
	{:else}
		<ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
			{#each jobs.items as job (`${job.print_id}/${job.path}`)}
				{@const key = `${job.print_id}/${job.path}`}
				{@const src = thumbUrl(job)}
				{@const title = job.title ? plainText(job.title) : job.print_id}
				<li class="group overflow-hidden rounded-lg border border-stone-800 bg-stone-900/50 hover:border-stone-600">
					<a
						href={job.onSite ? viewerHref(job) : (src ?? viewerHref(job))}
						class="relative block aspect-[4/3] bg-stone-950"
						title={job.onSite ? 'Open the full-screen viewer' : 'This print is not in the local database; opens the image'}
					>
						{#if src && !broken[key]}
							<img
								{src}
								alt="Render of {title}, {pageName(job)}"
								loading="lazy"
								decoding="async"
								class="size-full object-contain"
								onerror={() => (broken[key] = true)}
							/>
						{:else}
							<span class="flex size-full items-center justify-center px-2 text-center text-xs text-stone-600">
								{src ? "Image didn't load" : 'No overview recorded'}
							</span>
						{/if}
						{#if job.game_version}
							<span class="absolute top-1.5 left-1.5 rounded bg-stone-950/80 px-1 py-0.5 font-mono text-[10px] text-stone-400">{job.game_version}</span>
						{/if}
					</a>
					<div class="space-y-1 p-2 text-xs">
						<p class="truncate text-sm text-stone-100" title={title}>{title}</p>
						<p class="truncate text-stone-400" title={job.path ? `Book path ${job.path}` : 'Lone blueprint'}>{pageName(job)}</p>
						<p class="flex flex-wrap gap-x-2 text-stone-500 tabular-nums">
							<span>{int(job.entities)} entities</span>
							<span title="Render time">{ms(job.ms)}</span>
							{#if job.bytes !== null}<span title="{int(job.files ?? 0)} files">{bytes(job.bytes)}</span>{/if}
						</p>
						<p class="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
							<span class="flex gap-2">
								{#if job.onSite}
									<a href={viewerHref(job)} class="text-amber-400 hover:text-amber-300">Viewer</a>
									<a href={printHref(job)} class="text-amber-400 hover:text-amber-300">Print</a>
								{:else}
									<span class="text-stone-600" title="Not in the local database: run the backfill for it">not ingested</span>
								{/if}
							</span>
							{#if job.finished_at}<span class="text-stone-600 tabular-nums">{clock(job.finished_at, now, timeZone)}</span>{/if}
						</p>
					</div>
				</li>
			{/each}
		</ul>
		<Pager param="rendered" current={jobs.page} pages={jobs.pages} anchor="rendered" label="Rendered pages" />
	{/if}
</section>
