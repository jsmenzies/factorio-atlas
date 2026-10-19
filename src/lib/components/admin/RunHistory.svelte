<script lang="ts">
	import type { PipelineRun } from '#lib/server/pipeline/runs.js';
	import { compact, duration, elapsed, int, KIND_LABEL, outcomeParts, shownState, when } from './metrics.js';
	import OutcomeBar from './OutcomeBar.svelte';
	import StageBadge from './StageBadge.svelte';
	import StateBadge from './StateBadge.svelte';

	let {
		runs,
		older,
		newer,
		current,
		now,
		staleMs,
		timeZone
	}: { runs: PipelineRun[]; older: number | null; newer: boolean; current?: string; now: number; staleMs: number; timeZone?: string } = $props();

	/** "1,100 analysed · 24 failed": the two biggest outcomes, failures always. */
	const outcomeText = (run: PipelineRun) => {
		const parts = outcomeParts(run);
		const failed = parts.filter((p) => p.key === 'failed');
		const top = parts
			.filter((p) => p.key !== 'failed')
			.sort((a, b) => b.n - a.n)
			.slice(0, 2);
		return [...top, ...failed].map((p) => `${compact(p.n)} ${p.label.toLowerCase()}`).join(' · ') || 'nothing done';
	};
	const cols = 'md:grid-cols-[minmax(9rem,1.1fr)_minmax(7rem,0.8fr)_8rem_6rem_minmax(12rem,2fr)_6rem_8rem]';
</script>

<section class="space-y-3" aria-labelledby="history">
	<h2 id="history" class="text-lg font-semibold text-stone-100">History</h2>
	{#if runs.length === 0}
		<p class="text-sm text-stone-500">No runs {newer ? 'older than these' : 'yet'}.</p>
	{:else}
		<div class="overflow-hidden rounded-lg border border-stone-800">
			<div class="hidden gap-4 border-b border-stone-800 bg-stone-900 px-3 py-2 text-xs font-medium tracking-wide text-stone-500 uppercase md:grid {cols}">
				<span>Run</span><span>Host</span><span>Started</span><span>Took</span><span>Outcomes</span><span class="text-right">D1 rows</span><span>State</span>
			</div>
			<ul class="divide-y divide-stone-800">
				{#each runs as run (run.id)}
					{@const runState = shownState(run, now, staleMs)}
					<li>
						<a
							href="/admin/pipeline/{run.id}"
							class="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 px-3 py-2.5 text-sm hover:bg-stone-900 md:items-center {cols} {run.id === current
								? 'bg-stone-900/70'
								: ''}"
							aria-current={run.id === current ? 'page' : undefined}
						>
							<span class="flex items-center gap-2">
								<span class="font-medium text-stone-100">{KIND_LABEL[run.kind]}</span>
								<StageBadge stage={run.stage} />
							</span>
							<span class="justify-self-end md:order-last md:justify-self-start"><StateBadge state={runState} /></span>
							<span class="col-span-2 truncate text-stone-400 md:col-span-1">{run.host}</span>
							<span class="text-stone-300 md:col-span-1">{when(run.started_at, now, timeZone)}</span>
							<span class="text-right text-stone-400 tabular-nums md:text-left">{duration(elapsed(run, runState, now))}</span>
							<span class="col-span-2 space-y-1 md:col-span-1">
								<OutcomeBar {run} size="sm" />
								<span class="block text-xs text-stone-400">{int(run.done)}/{int(run.total)} · {outcomeText(run)}</span>
							</span>
							<span class="col-span-2 text-xs text-stone-400 tabular-nums md:col-span-1 md:text-right md:text-sm md:text-stone-300"
								><span class="md:hidden">D1 rows written:{' '}</span>{int(run.rows_written)}</span
							>
						</a>
					</li>
				{/each}
			</ul>
		</div>
		<nav class="flex gap-4 text-sm" aria-label="History pages">
			{#if newer}<a href="/admin/pipeline" class="text-amber-400 hover:text-amber-300">← Latest runs</a>{/if}
			{#if older}<a href="/admin/pipeline?older={older}" class="text-amber-400 hover:text-amber-300">Older runs →</a>{/if}
		</nav>
	{/if}
</section>
