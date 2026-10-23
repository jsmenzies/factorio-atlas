<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { PipelineRun } from '#lib/server/pipeline/runs.js';
	import { ago, duration, elapsed, isLiveState, when, type ShownState } from './metrics.js';
	import StateBadge from './StateBadge.svelte';

	/** A run's heading (`heading`, then its state), when it started and how long it took, and its host, source and option chips. */
	let {
		run,
		runState,
		chips,
		now,
		timeZone,
		heading
	}: {
		run: Pick<PipelineRun, 'id' | 'host' | 'source' | 'started_at' | 'updated_at' | 'finished_at'>;
		runState: ShownState;
		chips: string[];
		now: number;
		timeZone?: string;
		heading: Snippet;
	} = $props();

	const ended = $derived(!isLiveState(runState) && runState !== 'crashed');
</script>

<header class="space-y-2">
	<div class="flex flex-wrap items-center gap-2">
		{@render heading()}
		<StateBadge state={runState} />
	</div>
	<p class="flex flex-wrap gap-x-3 gap-y-1 text-sm text-stone-400">
		<span>Started {when(run.started_at, now, timeZone)}</span>
		<span class="text-stone-600" aria-hidden="true">·</span>
		<span>{ended ? 'took' : runState === 'crashed' ? 'ran for' : 'running for'} {duration(elapsed(run, runState, now))}</span>
		{#if !ended}
			<span class="text-stone-600" aria-hidden="true">·</span>
			<span class={runState === 'crashed' ? 'text-rose-300' : ''}>last heartbeat {ago(now - run.updated_at)}</span>
		{:else if run.finished_at}
			<span class="text-stone-600" aria-hidden="true">·</span>
			<span>ended {when(run.finished_at, now, timeZone)}</span>
		{/if}
	</p>
	<p class="flex flex-wrap items-center gap-1.5 text-xs text-stone-400">
		<span class="rounded bg-stone-800 px-1.5 py-0.5" title="Host">{run.host}</span>
		<span class="rounded bg-stone-800 px-1.5 py-0.5 font-mono" title="Source">{run.source}</span>
		{#each chips as chip (chip)}<span class="rounded bg-stone-800 px-1.5 py-0.5">{chip}</span>{/each}
		<span class="font-mono text-stone-600" title="Run id">{run.id}</span>
	</p>
</header>
