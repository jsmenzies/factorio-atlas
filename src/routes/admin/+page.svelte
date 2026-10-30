<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { PIPELINE_DEP, poll, serverClock, syncTimeZone } from '#lib/components/admin/live.svelte.js';
	import { clock as clockText, duration, int } from '#lib/components/admin/metrics.js';
	import Attention from '#lib/components/admin/sync/Attention.svelte';
	import Figures from '#lib/components/admin/sync/Figures.svelte';
	import SyncHistory from '#lib/components/admin/sync/SyncHistory.svelte';
	import { sourceRunRows, STEP_MARK, updateState } from '#lib/components/admin/sync/view.js';
	import { stepLabel } from '#lib/sync.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// A load that met a locked database (a run writing) returns `busy`: keep showing the last data.
	type Loaded = Extract<PageProps['data'], { busy: false }>;
	let last: Loaded | null = null;
	const view = $derived.by(() => {
		if (!data.busy) last = data;
		return data.busy ? last : data;
	});

	const offset = $derived(data.serverNow - Date.now());
	const clock = serverClock(() => offset);
	const run = $derived(view?.runs[0] ?? null);
	const phase = $derived(view ? updateState(run, view.plan?.value ?? null, clock.now) : null);
	// Every 3 s while an update runs (or a render run started by hand), else every minute for the ages.
	const interval = $derived(data.busy ? 2000 : phase === 'running' || view?.liveRender ? 3000 : 60_000);
	poll(() => interval);
	syncTimeZone(() => data.timeZone);

	let refreshing = $state(false);
	const refresh = async () => {
		refreshing = true;
		await invalidate(PIPELINE_DEP);
		refreshing = false;
	};

	/** What the last (or running) update pulled from each source, in words. */
	const pulled = $derived(
		run
			? run.sources
					.map((s) => ({ site: s.site, rows: sourceRunRows(run, s.site).filter((r) => r.value !== 0) }))
					.filter((s) => s.rows.length)
			: []
	);
	const current = $derived(run?.steps.find((s) => s.status === 'running'));
</script>

<svelte:head><title>Overview · Admin · Blueprint Atlas</title></svelte:head>

<div class="space-y-6">
	<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
		<h1 class="text-2xl font-semibold text-stone-100">Overview</h1>
		<p class="flex items-center gap-3 text-xs text-stone-500">
			{#if data.busy}<span class="text-amber-300" role="status">Database busy (a run is writing), retrying…</span>{:else}<span>Local · this machine</span>{/if}
			<button type="button" onclick={refresh} disabled={refreshing} class="rounded border border-stone-800 px-2 py-0.5 text-stone-400 hover:text-stone-200">
				{refreshing ? 'Refreshing…' : 'Refresh'}
			</button>
		</p>
	</div>

	{#if !view}
		<div class="rounded-lg border border-dashed border-stone-800 p-6 text-sm text-stone-400">
			<p class="text-stone-200">The local database is busy (a run is writing to it); trying again in a moment.</p>
		</div>
	{:else}
		<Attention figures={view.figures?.value ?? null} plan={view.plan?.value ?? null} {run} totals={view.totals} now={clock.now} />

		<Figures figures={view.figures?.value ?? null} scopes={view.scopes} totals={view.totals} now={clock.now} />

		{#if run}
			<section class="rounded-lg border border-stone-800 bg-stone-900/50 p-4" aria-labelledby="last-title">
				<div class="flex flex-wrap items-start justify-between gap-3">
					<div class="min-w-0">
						<h2 id="last-title" class="text-xs font-semibold tracking-wide text-stone-500 uppercase">
							{phase === 'running' ? 'Update running' : 'Last update'}
						</h2>
						<p class="mt-0.5 text-sm text-stone-200">
							{#if phase === 'running'}
								{current ? stepLabel(current.id) : 'Starting'} · running {duration(clock.now - run.started_at)}
							{:else}
								{run.state} {clockText(run.finished_at ?? run.updated_at, clock.now, data.timeZone)} · took {duration((run.finished_at ?? run.updated_at) - run.started_at)} · to
								{run.stage}
							{/if}
						</p>
					</div>
					<a href="/admin/update" class="rounded-lg border border-stone-700 bg-stone-800 px-3 py-1.5 text-sm font-medium text-stone-100 hover:bg-stone-700">Open Update</a>
				</div>
				<ol class="mt-3 flex flex-wrap gap-1.5" aria-label="Steps">
					{#each run.steps as s (s.id)}
						<li class="flex items-center gap-1.5 rounded-md border border-stone-800 px-2 py-1 text-xs" title={s.summary ?? STEP_MARK[s.status].label}>
							<span class="grid size-4 place-items-center rounded text-[0.6rem] font-bold {STEP_MARK[s.status].class}">{STEP_MARK[s.status].mark}</span>
							<span class={s.status === 'skipped' || s.status === 'pending' ? 'text-stone-500' : 'text-stone-300'}>{stepLabel(s.id)}</span>
						</li>
					{/each}
				</ol>
				{#if pulled.length}
					<dl class="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
						{#each pulled as p (p.site)}
							<div class="min-w-0">
								<dt class="inline font-medium text-stone-200">{p.site}:</dt>
								<dd class="inline text-stone-400">
									{p.rows.map((r) => `${typeof r.value === 'number' ? int(r.value) : r.value} ${r.label}`).join(', ')}
								</dd>
							</div>
						{/each}
					</dl>
				{/if}
			</section>
		{/if}

		<SyncHistory runs={view.runs} now={clock.now} timeZone={data.timeZone} />
	{/if}
</div>
