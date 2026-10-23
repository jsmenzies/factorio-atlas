<script lang="ts" generics="T extends { id: string; state: RunState; updated_at: number }">
	import type { Snippet } from 'svelte';
	import type { RunState } from '#lib/server/pipeline/runs.js';
	import { shownState, type ShownState } from './metrics.js';

	/**
	 * A history of runs, newest first: one row per run linking to `<base>/<id>`, paged back with
	 * `?older=`. The caller gives the column headings and each row's cells, laid out on `cols`.
	 */
	let {
		runs,
		base,
		cols,
		empty,
		older,
		newer,
		current,
		now,
		staleMs,
		headings,
		cells
	}: {
		runs: T[];
		base: string;
		cols: string;
		/** What to call no runs at all: "No runs", "No render runs". */
		empty: string;
		older: number | null;
		newer: boolean;
		current?: string;
		now: number;
		staleMs: number;
		headings: Snippet;
		cells: Snippet<[T, ShownState]>;
	} = $props();
</script>

<section class="space-y-3" aria-labelledby="history">
	<h2 id="history" class="text-lg font-semibold text-stone-100">History</h2>
	{#if runs.length === 0}
		<p class="text-sm text-stone-500">{empty} {newer ? 'older than these' : 'yet'}.</p>
	{:else}
		<div class="overflow-hidden rounded-lg border border-stone-800">
			<div class="hidden gap-4 border-b border-stone-800 bg-stone-900 px-3 py-2 text-xs font-medium tracking-wide text-stone-500 uppercase md:grid {cols}">
				{@render headings()}
			</div>
			<ul class="divide-y divide-stone-800">
				{#each runs as run (run.id)}
					<li>
						<a
							href="{base}/{run.id}"
							class="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 px-3 py-2.5 text-sm hover:bg-stone-900 md:items-center {cols} {run.id === current
								? 'bg-stone-900/70'
								: ''}"
							aria-current={run.id === current ? 'page' : undefined}
						>
							{@render cells(run, shownState(run, now, staleMs))}
						</a>
					</li>
				{/each}
			</ul>
		</div>
		<nav class="flex gap-4 text-sm" aria-label="History pages">
			{#if newer}<a href={base} class="text-amber-400 hover:text-amber-300">← Latest runs</a>{/if}
			{#if older}<a href="{base}?older={older}" class="text-amber-400 hover:text-amber-300">Older runs →</a>{/if}
		</nav>
	{/if}
</section>
