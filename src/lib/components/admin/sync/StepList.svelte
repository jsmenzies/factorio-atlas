<script lang="ts">
	import type { Snippet } from 'svelte';
	import { stepLabel, type StepStatus, type SyncStepId } from '#lib/sync.js';
	import { duration } from '../metrics.js';
	import { STEP_MARK } from './view.js';

	/**
	 * An update's steps in order: a preview (no status: numbered), or a run's steps with their marks,
	 * times and summaries. `extra` renders under one step (the render step's progress).
	 */
	let {
		steps,
		now,
		extra
	}: {
		steps: { id: SyncStepId; status?: StepStatus; text?: string; idle?: boolean; startedAt?: number; finishedAt?: number; runId?: string }[];
		now: number;
		extra?: Snippet<[SyncStepId]>;
	} = $props();

</script>

<ol class="divide-y divide-stone-800/70 border-t border-stone-800">
	{#each steps as s, i (s.id)}
		{@const mark = s.status ? STEP_MARK[s.status] : null}
		<li class="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 py-2.5 sm:grid-cols-[1.75rem_minmax(0,1fr)_auto]">
			<span
				class="grid size-6 place-items-center rounded-md text-xs font-bold {mark ? mark.class : 'bg-stone-800 text-stone-400'}"
				title={mark?.label}
			>
				{mark ? mark.mark || i + 1 : i + 1}
			</span>
			<div class="min-w-0 {s.idle || s.status === 'skipped' || s.status === 'stopped' ? 'text-stone-500' : ''}">
				<p class="text-sm font-medium {s.idle || s.status === 'skipped' || s.status === 'stopped' ? 'text-stone-400' : 'text-stone-100'}">
					{stepLabel(s.id)}
				</p>
				{#if s.text}<p class="text-sm break-words {s.status === 'failed' ? 'text-rose-300' : s.status === 'warning' ? 'text-amber-200' : 'text-stone-400'}">{s.text}</p>{/if}
				{@render extra?.(s.id)}
			</div>
			<p class="col-start-2 text-xs whitespace-nowrap text-stone-500 tabular-nums sm:col-start-3 sm:text-right">
				{#if s.startedAt && (s.finishedAt || s.status === 'running')}{duration((s.finishedAt ?? now) - s.startedAt)}{/if}
				<!-- The render run is in the local database; the prints step's backfill run is in the stage's. -->
				{#if s.id === 'render' && s.runId}
					· <a href="/admin/render/{s.runId}" class="text-stone-400 underline decoration-stone-600 hover:text-amber-300">render run</a>
				{/if}
			</p>
		</li>
	{/each}
</ol>
