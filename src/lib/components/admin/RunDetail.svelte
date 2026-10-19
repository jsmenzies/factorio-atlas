<script lang="ts">
	import type { FailedPrint } from '#lib/server/admin/pipeline.js';
	import { D1_MONTHLY_ROWS, fullRunEstimate, R2_FREE_CLASS_A } from '#lib/run-estimate.js';
	import type { PipelineRun } from '#lib/server/pipeline/runs.js';
	import FailedPrints from './FailedPrints.svelte';
	import {
		ago,
		bytes,
		clock,
		compact,
		duration,
		elapsed,
		eta,
		failureRows,
		int,
		isLiveState,
		KIND_LABEL,
		OUTCOMES,
		optionChips,
		percent,
		projection,
		rateText,
		shownState,
		when
	} from './metrics.js';
	import OutcomeBar from './OutcomeBar.svelte';
	import RunControls from './RunControls.svelte';
	import StageBadge from './StageBadge.svelte';
	import StateBadge from './StateBadge.svelte';

	let {
		run,
		failed,
		now,
		staleMs,
		heartbeatMs,
		message,
		timeZone
	}: {
		run: PipelineRun;
		failed: { items: FailedPrint[]; total: number; page: number; pages: number; perPage: number };
		now: number;
		staleMs: number;
		heartbeatMs: number;
		message?: string;
		timeZone?: string;
	} = $props();

	const runState = $derived(shownState(run, now, staleMs));
	const live = $derived(isLiveState(runState));
	const ended = $derived(!live && runState !== 'crashed');
	const left = $derived(Math.max(0, run.total - run.done));
	const pct = $derived(run.total > 0 ? Math.min(100, (run.done / run.total) * 100) : 0);
	const rate = $derived(rateText(run.rate));
	const finish = $derived(live && runState !== 'paused' ? eta(run, now) : null);
	const proj = $derived(projection(run));
	const reasons = $derived(failureRows(run.failures));
	const reasonMax = $derived(Math.max(1, ...reasons.map(([, n]) => n)));
	const chips = $derived(optionChips(run.options));
	const projectedRows = $derived(ended ? run.rows_written : (proj?.rows ?? run.rows_written));
	const projectedObjects = $derived(ended ? run.r2_objects : (proj?.objects ?? run.r2_objects));
	const projectedBytes = $derived(ended ? run.r2_bytes : (proj?.bytes ?? run.r2_bytes));
	const showProjection = $derived(!ended && proj !== null && run.total > run.done);
	// A sample run (--limit/--ids) also says what loading the whole mirror would take.
	const full = $derived(run.options.corpus && run.total < run.options.corpus ? fullRunEstimate(run) : null);

	const card = 'rounded-lg border border-stone-800 bg-stone-900/50 p-4';
	const label = 'text-xs font-medium tracking-wide text-stone-500 uppercase';
</script>

<article class="space-y-5">
	<!-- What this run is -->
	<header class="space-y-2">
		<div class="flex flex-wrap items-center gap-2">
			<h2 class="text-xl font-semibold text-stone-100">{KIND_LABEL[run.kind]}</h2>
			<StageBadge stage={run.stage} />
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

	{#if runState === 'crashed'}
		<div class="rounded-lg border border-rose-800/70 bg-rose-950/40 p-4 text-sm" role="alert">
			<p class="font-medium text-rose-200">
				Runner not responding since {clock(run.updated_at, now, timeZone)} ({ago(now - run.updated_at)}).
			</p>
			<p class="mt-1 text-rose-200/80">
				It may have crashed, the machine may be asleep, or it lost its network. If it comes back it carries on (and acts on any request
				below). Otherwise run the same command again: prints it finished are skipped.
			</p>
		</div>
	{/if}
	{#if run.state === 'failed' && run.error}
		<div class="rounded-lg border border-rose-800/70 bg-rose-950/40 p-4 text-sm" role="alert">
			<p class="font-medium text-rose-200">The run failed</p>
			<p class="mt-1 font-mono text-xs break-words whitespace-pre-wrap text-rose-200/80">{run.error}</p>
		</div>
	{/if}

	<RunControls {run} {heartbeatMs} {message} />

	<!-- Progress and outcomes -->
	<section class="{card} space-y-4" aria-label="Progress">
		<div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
			<p class="text-stone-300">
				<span class="text-3xl font-semibold text-stone-100 tabular-nums">{run.total > 0 ? `${Math.floor(pct)}%` : '–'}</span>
				<span class="ml-2 tabular-nums">{int(run.done)} of {int(run.total)} prints</span>
				{#if left > 0}<span class="text-stone-500"> · {int(left)} {ended ? 'not processed' : 'left'}</span>{/if}
			</p>
			{#if finish && finish.left > 0}
				<p class="text-sm text-stone-300">
					<span class="text-stone-500">ETA</span>
					{duration(finish.left)} <span class="text-stone-500">· around {clock(finish.at, now, timeZone)}</span>
				</p>
			{:else if runState === 'paused'}
				<p class="text-sm text-amber-300">Paused</p>
			{/if}
		</div>
		<OutcomeBar {run} />
		<dl class="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
			{#each OUTCOMES as o (o.key)}
				{@const n = run[o.key]}
				<div class="flex items-start gap-2 {n === 0 ? 'opacity-45' : ''}">
					<span class="mt-1.5 size-2.5 shrink-0 rounded-sm {o.color}" aria-hidden="true"></span>
					<div class="min-w-0">
						<dt class="text-stone-200">
							{o.label}
							<span class="ml-1 text-stone-100 tabular-nums">{int(n)}</span>
							{#if n > 0 && run.done > 0}<span class="text-xs text-stone-500"> {percent(n, run.done)}</span>{/if}
						</dt>
						<dd class="text-xs text-stone-500">{o.hint}</dd>
					</div>
				</div>
			{/each}
		</dl>
	</section>

	<!-- Speed, cost, failures -->
	<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
		<section class="{card} space-y-1" aria-label="Speed">
			<h3 class={label}>Speed</h3>
			{#if ended}
				<p class="text-lg text-stone-100 tabular-nums">
					{run.done > 0 && elapsed(run, runState, now) > 0 ? rateText(run.done / (elapsed(run, runState, now) / 1000)) : '–'}
				</p>
				<p class="text-sm text-stone-500">average over {duration(elapsed(run, runState, now))}</p>
			{:else if runState === 'crashed'}
				<p class="text-lg text-stone-400">–</p>
				<p class="text-sm text-stone-500">no heartbeat; last measured {rate ?? 'nothing'}</p>
			{:else}
				<p class="text-lg text-stone-100 tabular-nums">{runState === 'paused' ? 'paused' : (rate ?? 'measuring…')}</p>
				<p class="text-sm text-stone-500">over the last 5 minutes</p>
			{/if}
		</section>

		<section class="{card} space-y-1" aria-label="D1 rows written">
			<h3 class={label}>D1 rows written</h3>
			<p class="text-lg text-stone-100 tabular-nums">{int(run.rows_written)}</p>
			{#if proj}<p class="text-sm text-stone-500">{+proj.rowsPerPrint.toFixed(1)} per print processed</p>{/if}
			<div class="space-y-1 pt-1">
				<div class="h-1.5 overflow-hidden rounded-full bg-stone-800">
					<div class="h-full rounded-full bg-amber-400/80" style="width: {Math.min(100, Math.max(0.5, (projectedRows / D1_MONTHLY_ROWS) * 100))}%"></div>
				</div>
				<p class="text-sm text-stone-300">
					{#if showProjection}≈ {compact(projectedRows)} for the run ·{:else if !ended && !proj}<span class="text-stone-500">Projected once prints are done.</span>{/if}
					{#if ended || proj}<span class="text-stone-500">{percent(projectedRows, D1_MONTHLY_ROWS)} of the 50M a month in Workers Paid</span>{/if}
				</p>
				{#if full}<p class="text-xs text-stone-500">Full run of {int(full.prints)} prints ≈ {compact(full.rows)} rows</p>{/if}
			</div>
		</section>

		<section class="{card} space-y-1" aria-label="R2 writes">
			<h3 class={label}>R2 objects written</h3>
			<p class="text-lg text-stone-100 tabular-nums">{int(run.r2_objects)} <span class="text-sm text-stone-400">· {bytes(run.r2_bytes)}</span></p>
			<div class="space-y-1 pt-1">
				<div class="h-1.5 overflow-hidden rounded-full bg-stone-800">
					<div class="h-full rounded-full bg-sky-400/80" style="width: {Math.min(100, Math.max(0.5, (projectedObjects / R2_FREE_CLASS_A) * 100))}%"></div>
				</div>
				<p class="text-sm text-stone-300">
					{#if showProjection}≈ {compact(projectedObjects)} objects, {bytes(projectedBytes)} for the run ·{:else if !ended && !proj}<span
							class="text-stone-500">Projected once prints are done.</span
						>{/if}
					{#if ended || proj}<span class="text-stone-500">{percent(projectedObjects, R2_FREE_CLASS_A)} of R2's free 1M writes a month (shared by the account)</span
						>{/if}
				</p>
			</div>
		</section>

		<section class="{card} space-y-2" aria-label="Failures by reason">
			<h3 class={label}>Failures by reason</h3>
			{#if reasons.length === 0}
				<p class="text-sm text-stone-500">None{run.failed + run.skipped_failed > 0 ? ' broken down yet' : ''}.</p>
			{:else}
				<ul class="space-y-1.5 text-sm">
					{#each reasons as [reason, n] (reason)}
						<li>
							<div class="flex justify-between gap-2">
								<span class="truncate font-mono text-xs text-stone-300" title={reason}>{reason}</span>
								<span class="text-stone-100 tabular-nums">{int(n)}</span>
							</div>
							<div class="mt-0.5 h-1 overflow-hidden rounded-full bg-stone-800">
								<div class="h-full rounded-full bg-rose-500/70" style="width: {(n / reasonMax) * 100}%"></div>
							</div>
						</li>
					{/each}
				</ul>
				{#if failed.total > 0}<a href="#failed" class="text-xs text-amber-400 hover:text-amber-300">See the prints ↓</a>{/if}
			{/if}
		</section>
	</div>

	<FailedPrints {failed} {now} {timeZone} />
</article>
