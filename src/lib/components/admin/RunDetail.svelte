<script lang="ts">
	import type { FailedPrint } from '#lib/server/admin/pipeline.js';
	import { D1_MONTHLY_ROWS, fullRunEstimate, R2_FREE_CLASS_A } from '#lib/run-estimate.js';
	import type { PipelineRun } from '#lib/server/pipeline/runs.js';
	import FailedPrints from './FailedPrints.svelte';
	import {
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
		STOP_NOTE
	} from './metrics.js';
	import OutcomeBar from './OutcomeBar.svelte';
	import OutcomeList from './OutcomeList.svelte';
	import ReasonBars from './ReasonBars.svelte';
	import RunAlerts from './RunAlerts.svelte';
	import RunControls from './RunControls.svelte';
	import RunHeader from './RunHeader.svelte';
	import StageBadge from './StageBadge.svelte';

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
	<RunHeader {run} {runState} {chips} {now} {timeZone}>
		{#snippet heading()}
			<h2 class="text-xl font-semibold text-stone-100">{KIND_LABEL[run.kind]}</h2>
			<StageBadge stage={run.stage} />
		{/snippet}
	</RunHeader>

	<RunAlerts {run} {runState} who="Runner" {now} {timeZone}>
		{#snippet advice()}
			It may have crashed, the machine may be asleep, or it lost its network. If it comes back it carries on (and acts on any request
			below). Otherwise run the same command again: prints it finished are skipped.
		{/snippet}
	</RunAlerts>

	<RunControls {run} {heartbeatMs} {message} who="runner" stopNote={STOP_NOTE} />

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
		<OutcomeList {run} outcomes={OUTCOMES} columns="lg:grid-cols-3" />
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
				<ReasonBars {reasons} bar="bg-rose-500/70" />
				{#if failed.total > 0}<a href="#failed" class="text-xs text-amber-400 hover:text-amber-300">See the prints ↓</a>{/if}
			{/if}
		</section>
	</div>

	<FailedPrints {failed} {now} {timeZone} />
</article>
