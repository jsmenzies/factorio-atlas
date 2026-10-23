<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { PipelineRun } from '#lib/server/pipeline/runs.js';
	import { ago, clock, type ShownState } from './metrics.js';

	/** A run that stopped answering (`advice`: what to do about it), or that failed, with its error. */
	let {
		run,
		runState,
		who,
		now,
		timeZone,
		advice
	}: {
		run: Pick<PipelineRun, 'state' | 'updated_at' | 'error'>;
		runState: ShownState;
		who: 'Runner' | 'Renderer';
		now: number;
		timeZone?: string;
		advice: Snippet;
	} = $props();
</script>

{#if runState === 'crashed'}
	<div class="rounded-lg border border-rose-800/70 bg-rose-950/40 p-4 text-sm" role="alert">
		<p class="font-medium text-rose-200">
			{who} not responding since {clock(run.updated_at, now, timeZone)} ({ago(now - run.updated_at)}).
		</p>
		<p class="mt-1 text-rose-200/80">{@render advice()}</p>
	</div>
{/if}
{#if run.state === 'failed' && run.error}
	<div class="rounded-lg border border-rose-800/70 bg-rose-950/40 p-4 text-sm" role="alert">
		<p class="font-medium text-rose-200">The run failed</p>
		<p class="mt-1 font-mono text-xs break-words whitespace-pre-wrap text-rose-200/80">{run.error}</p>
	</div>
{/if}
