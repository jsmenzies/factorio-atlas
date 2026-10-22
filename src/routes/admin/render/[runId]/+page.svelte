<script lang="ts">
	import { isLiveState, shownState, when } from '#lib/components/admin/metrics.js';
	import { poll, serverClock, syncTimeZone } from '#lib/components/admin/live.svelte.js';
	import JobTable from '#lib/components/admin/render/JobTable.svelte';
	import QueueOverview from '#lib/components/admin/render/QueueOverview.svelte';
	import RenderGrid from '#lib/components/admin/render/RenderGrid.svelte';
	import RenderRunDetail from '#lib/components/admin/render/RenderRunDetail.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// A load that met a locked database (a run writing) returns `busy`: keep showing this run's last data.
	type Loaded = Extract<PageProps['data'], { busy: false }>;
	let last: Loaded | null = null;
	const view = $derived.by(() => {
		if (!data.busy) last = data;
		return data.busy ? (last?.runId === data.runId ? last : null) : data;
	});

	const offset = $derived(data.serverNow - Date.now());
	const clock = serverClock(() => offset);
	const runState = $derived(view ? shownState(view.run, clock.now, data.staleMs) : null);
	const interval = $derived(data.busy ? 2000 : runState && isLiveState(runState) ? 4000 : runState === 'crashed' ? 15000 : null);
	poll(() => interval);
	syncTimeZone(() => data.timeZone);

	const message = $derived(form && 'message' in form ? form.message : undefined);
	const scope = 'in this run';
</script>

<svelte:head
	><title>Render run {view ? when(view.run.started_at, data.serverNow, data.timeZone) : data.runId} · Admin · Blueprint Atlas</title></svelte:head
>

<div class="space-y-10">
	<div class="space-y-5">
		<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
			<a href="/admin/render" class="text-sm text-stone-400 hover:text-amber-300">← Render</a>
			{#if data.busy}<span class="text-xs text-amber-300" role="status">Database busy (a run is writing), retrying…</span>{/if}
		</div>
		{#if view}
			<RenderRunDetail
				run={view.run}
				skipReasons={view.runSkips}
				now={clock.now}
				staleMs={data.staleMs}
				heartbeatMs={data.heartbeatMs}
				{message}
				timeZone={data.timeZone}
			/>
		{:else}
			<div class="rounded-lg border border-dashed border-stone-800 p-6 text-sm text-stone-400">
				<p class="text-stone-200">The local database is busy (a run is writing to it); trying again in a moment.</p>
			</div>
		{/if}
	</div>

	{#if view}
		<QueueOverview
			queue={view.queue}
			title="Pages this run last touched"
			scope=""
			empty="No page is recorded under this run. A page shows under the run that last touched it, so a later run may have taken them over."
		/>
		{#if view.inFlight.total > 0}<JobTable jobs={view.inFlight} kind="rendering" now={clock.now} timeZone={data.timeZone} {scope} />{/if}
		<RenderGrid jobs={view.rendered} now={clock.now} timeZone={data.timeZone} {scope} />
		<JobTable jobs={view.failed} kind="failed" now={clock.now} timeZone={data.timeZone} {scope} />
		<JobTable jobs={view.skipped} kind="skipped" now={clock.now} timeZone={data.timeZone} {scope} />
	{/if}
</div>
