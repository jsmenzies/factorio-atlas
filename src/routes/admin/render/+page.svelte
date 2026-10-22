<script lang="ts">
	import { dev } from '$app/env';
	import { invalidate } from '$app/navigation';
	import { isLiveState, shownState } from '#lib/components/admin/metrics.js';
	import { PIPELINE_DEP, poll, serverClock, syncTimeZone } from '#lib/components/admin/live.svelte.js';
	import JobTable from '#lib/components/admin/render/JobTable.svelte';
	import QueueOverview from '#lib/components/admin/render/QueueOverview.svelte';
	import RenderGrid from '#lib/components/admin/render/RenderGrid.svelte';
	import RenderHistory from '#lib/components/admin/render/RenderHistory.svelte';
	import RenderRunDetail from '#lib/components/admin/render/RenderRunDetail.svelte';
	import ScopeOverview from '#lib/components/admin/render/ScopeOverview.svelte';
	import StartPanel from '#lib/components/admin/render/StartPanel.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// A load that met a locked database (a run writing) returns `busy`: keep showing the last data.
	type Loaded = Extract<PageProps['data'], { busy: false }>;
	let last: Loaded | null = null;
	const view = $derived.by(() => {
		if (!data.busy) last = data;
		return data.busy ? last : data;
	});

	// Ages and staleness tick every second on the server's clock; the data is re-loaded every few
	// seconds while a run is live (slower while it isn't responding), never while the tab is hidden.
	const offset = $derived(data.serverNow - Date.now());
	const clock = serverClock(() => offset);
	const runState = $derived(view?.run ? shownState(view.run, clock.now, data.staleMs) : null);
	const live = $derived(runState !== null && isLiveState(runState));
	const interval = $derived(data.busy ? 2000 : live ? 4000 : runState === 'crashed' ? 15000 : null);
	poll(() => interval);
	syncTimeZone(() => data.timeZone);

	let refreshing = $state(false);
	const refresh = async () => {
		refreshing = true;
		await invalidate(PIPELINE_DEP);
		refreshing = false;
	};
	const message = $derived(form && 'message' in form ? form.message : undefined);
</script>

<svelte:head><title>Render · Admin · Blueprint Atlas</title></svelte:head>

<div class="space-y-10">
	<div class="space-y-5">
		<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
			<h1 class="text-2xl font-semibold text-stone-100">Render</h1>
			<p class="flex items-center gap-3 text-xs text-stone-500">
				{#if data.busy}
					<span class="text-amber-300" role="status">Database busy (a run is writing), retrying…</span>
				{:else if live}
					<span>Updating every 4 s</span>
				{:else if runState === 'crashed'}
					<span>Checking every 15 s</span>
				{:else}
					<span>No run is live</span>
				{/if}
				<button type="button" onclick={refresh} disabled={refreshing} class="rounded border border-stone-800 px-2 py-0.5 text-stone-400 hover:text-stone-200">
					{refreshing ? 'Refreshing…' : 'Refresh'}
				</button>
			</p>
		</div>

		{#if dev && view}
			<StartPanel
				run={view.run}
				{live}
				crashed={runState === 'crashed'}
				heartbeatMs={data.heartbeatMs}
				{message}
				storedTop={view.scopes.favorites?.n ?? null}
			/>
		{/if}

		{#if !view}
			<div class="rounded-lg border border-dashed border-stone-800 p-6 text-sm text-stone-400">
				<p class="text-stone-200">The local database is busy (a run is writing to it); trying again in a moment.</p>
			</div>
		{:else if view.run}
			<p class="text-xs font-medium tracking-wide text-stone-500 uppercase">{live || runState === 'crashed' ? 'Current run' : 'Latest run'}</p>
			<RenderRunDetail
				controls={!dev}
				run={view.run}
				skipReasons={view.runSkips}
				now={clock.now}
				staleMs={data.staleMs}
				heartbeatMs={data.heartbeatMs}
				{message}
				timeZone={data.timeZone}
				href="/admin/render/{view.run.id}"
			/>
		{:else}
			<div class="rounded-lg border border-dashed border-stone-800 p-6 text-sm text-stone-400">
				<p class="text-stone-200">No render runs yet.</p>
				<p class="mt-1">
					Start one from a terminal on the machine with the sprite assets, e.g. <code class="rounded bg-stone-800 px-1 text-stone-200">bun run render</code>.
					It shows up here within a few seconds.
				</p>
			</div>
		{/if}
	</div>

	{#if view}
		<ScopeOverview scopes={view.scopes} now={clock.now} controls={dev} {live} />
		<QueueOverview queue={view.queue} />
		{#if view.inFlight.total > 0}<JobTable jobs={view.inFlight} kind="rendering" now={clock.now} timeZone={data.timeZone} />{/if}
		<RenderGrid jobs={view.rendered} now={clock.now} timeZone={data.timeZone} />
		<JobTable jobs={view.failed} kind="failed" now={clock.now} timeZone={data.timeZone} />
		<JobTable jobs={view.skipped} kind="skipped" now={clock.now} timeZone={data.timeZone} />

		<RenderHistory
			runs={view.history.runs}
			older={view.history.older}
			newer={view.newer}
			current={view.run?.id}
			now={clock.now}
			staleMs={data.staleMs}
			timeZone={data.timeZone}
		/>
	{/if}
</div>
