<script lang="ts">
	import type { RenderRun } from '#lib/server/admin/render.js';
	import { bytes, duration, elapsed, int, outcomeSummary, when } from '../metrics.js';
	import RunList from '../RunList.svelte';
	import StateBadge from '../StateBadge.svelte';
	import { renderOutcomeParts } from './metrics.js';
	import RenderOutcomeBar from './RenderOutcomeBar.svelte';

	let {
		runs,
		older,
		newer,
		current,
		now,
		staleMs,
		timeZone
	}: { runs: RenderRun[]; older: number | null; newer: boolean; current?: string; now: number; staleMs: number; timeZone?: string } = $props();
</script>

<RunList
	{runs}
	base="/admin/render"
	cols="md:grid-cols-[minmax(9rem,1fr)_minmax(7rem,0.8fr)_6rem_minmax(12rem,2fr)_7rem_8rem]"
	empty="No render runs"
	{older}
	{newer}
	{current}
	{now}
	{staleMs}
>
	{#snippet headings()}
		<span>Started</span><span>Host</span><span>Took</span><span>Outcomes</span><span class="text-right">Written</span><span>State</span>
	{/snippet}
	{#snippet cells(run: RenderRun, runState)}
		<span class="font-medium text-stone-100">{when(run.started_at, now, timeZone)}</span>
		<span class="justify-self-end md:order-last md:justify-self-start"><StateBadge state={runState} /></span>
		<span class="col-span-2 truncate text-stone-400 md:col-span-1">{run.host}</span>
		<span class="text-stone-400 tabular-nums">{duration(elapsed(run, runState, now))}</span>
		<span class="col-span-2 space-y-1 md:col-span-1">
			<RenderOutcomeBar {run} size="sm" />
			<span class="block text-xs text-stone-400"
				>{int(run.done)}/{int(run.total)} pages{#if run.prints_total}{' · '}{int(run.prints_done ?? 0)}/{int(run.prints_total)} prints{/if} · {outcomeSummary(
					renderOutcomeParts(run)
				)}</span
			>
		</span>
		<span class="col-span-2 text-xs text-stone-400 tabular-nums md:col-span-1 md:text-right md:text-sm md:text-stone-300"
			><span class="md:hidden">Written:{' '}</span>{bytes(run.bytes)}</span
		>
	{/snippet}
</RunList>
