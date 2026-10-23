<script lang="ts">
	import type { PipelineRun } from '#lib/server/pipeline/runs.js';
	import { duration, elapsed, int, KIND_LABEL, outcomeParts, outcomeSummary, when } from './metrics.js';
	import OutcomeBar from './OutcomeBar.svelte';
	import RunList from './RunList.svelte';
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
</script>

<RunList
	{runs}
	base="/admin/pipeline"
	cols="md:grid-cols-[minmax(9rem,1.1fr)_minmax(7rem,0.8fr)_8rem_6rem_minmax(12rem,2fr)_6rem_8rem]"
	empty="No runs"
	{older}
	{newer}
	{current}
	{now}
	{staleMs}
>
	{#snippet headings()}
		<span>Run</span><span>Host</span><span>Started</span><span>Took</span><span>Outcomes</span><span class="text-right">D1 rows</span><span>State</span>
	{/snippet}
	{#snippet cells(run: PipelineRun, runState)}
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
			<span class="block text-xs text-stone-400">{int(run.done)}/{int(run.total)} · {outcomeSummary(outcomeParts(run))}</span>
		</span>
		<span class="col-span-2 text-xs text-stone-400 tabular-nums md:col-span-1 md:text-right md:text-sm md:text-stone-300"
			><span class="md:hidden">D1 rows written:{' '}</span>{int(run.rows_written)}</span
		>
	{/snippet}
</RunList>
