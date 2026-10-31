<script lang="ts">
	import type { Snippet } from 'svelte';
	import { stepLabel, type DetailGroup, type StepStatus, type SyncStepId } from '#lib/sync.js';
	import { duration, int } from '../metrics.js';
	import { STEP_MARK } from './view.js';

	/**
	 * An update's steps in order: a preview (no status: numbered), or a run's steps with their marks
	 * (a spinner on the running one), times and figures: `details` as rows in a panel when the run
	 * recorded them, else its one-line summary (older rows). A failed, warned or skipped step also
	 * shows its summary, which says why. `extra` renders under one step (the render step's progress).
	 */
	let {
		steps,
		now,
		extra,
		bare = false
	}: {
		steps: {
			id: SyncStepId;
			status?: StepStatus;
			text?: string;
			idle?: boolean;
			startedAt?: number;
			finishedAt?: number;
			runId?: string;
			details?: DetailGroup[];
		}[];
		now: number;
		extra?: Snippet<[SyncStepId]>;
		/** Only each step's figures panel (the Update tab's detail bar says the rest). */
		bare?: boolean;
	} = $props();

</script>

{#snippet figures(details: DetailGroup[])}
	<div class="mt-1.5 grid gap-x-8 gap-y-2 rounded-md border border-stone-800 bg-stone-950/60 px-3 py-2 {details.length > 1 ? 'max-w-2xl sm:grid-cols-2' : 'max-w-sm'}">
		{#each details as g, gi (gi)}
			<div class="min-w-0">
				{#if g.title}<p class="truncate text-xs font-semibold text-stone-400" title={g.title}>{g.title}</p>{/if}
				<dl class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 text-sm">
					{#each g.rows as r, ri (ri)}
						{#if r.muted}
							<dd class="col-span-full truncate text-xs text-stone-500" title={String(r.value)}>{r.label}: {r.value}</dd>
						{:else if typeof r.value === 'string' && r.value.length > 32}
							<dt class="col-span-full text-stone-400">{r.label}</dt>
							<dd class="col-span-full break-words {r.tone === 'bad' ? 'text-rose-300' : r.tone === 'warn' ? 'text-amber-200' : 'text-stone-200'}">{r.value}</dd>
						{:else}
							<dt class="truncate text-stone-400">{r.label}</dt>
							<dd class="text-right tabular-nums {r.tone === 'bad' ? 'text-rose-300' : r.tone === 'warn' ? 'text-amber-200' : 'text-stone-200'}">
								{typeof r.value === 'number' ? int(r.value) : r.value}
							</dd>
						{/if}
					{/each}
				</dl>
			</div>
		{/each}
	</div>
{/snippet}

{#if bare}
	{#each steps as s (s.id)}{#if s.details?.length}{@render figures(s.details)}{/if}{/each}
{:else}
<ol class="divide-y divide-stone-800/70 border-t border-stone-800">
	{#each steps as s, i (s.id)}
		{@const mark = s.status ? STEP_MARK[s.status] : null}
		<li class="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 py-2.5 sm:grid-cols-[1.75rem_minmax(0,1fr)_auto]">
			<span
				class="grid size-6 place-items-center rounded-md text-xs font-bold {mark ? mark.class : 'bg-stone-800 text-stone-400'}"
				title={mark?.label}
				role={s.status === 'running' ? 'status' : undefined}
				aria-label={s.status === 'running' ? 'Running' : undefined}
			>
				{#if s.status === 'running'}
					<!-- Spins unless the viewer asked for less motion; then a still ring with a dot. -->
					<svg viewBox="0 0 16 16" class="size-4 motion-safe:animate-spin" aria-hidden="true">
						<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-opacity="0.3" stroke-width="2" />
						<path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="motion-reduce:hidden" />
						<circle cx="8" cy="8" r="2" fill="currentColor" class="motion-safe:hidden" />
					</svg>
				{:else}
					{mark ? mark.mark : i + 1}
				{/if}
			</span>
			<div class="min-w-0 {s.idle || s.status === 'skipped' || s.status === 'stopped' ? 'text-stone-500' : ''}">
				<p class="text-sm font-medium {s.idle || s.status === 'skipped' || s.status === 'stopped' ? 'text-stone-400' : 'text-stone-100'}">
					{stepLabel(s.id)}
				</p>
				{#if s.text && (!s.details?.length || s.status === 'failed' || s.status === 'warning')}
					<p class="text-sm break-words {s.status === 'failed' ? 'text-rose-300' : s.status === 'warning' ? 'text-amber-200' : 'text-stone-400'}">{s.text}</p>
				{/if}
				{#if s.details?.length}{@render figures(s.details)}
				{/if}
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
{/if}
