<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { isLiveState, shownState } from '#lib/components/admin/metrics.js';
	import { PIPELINE_DEP, poll, serverClock, syncTimeZone } from '#lib/components/admin/live.svelte.js';
	import RunDetail from '#lib/components/admin/RunDetail.svelte';
	import RunHistory from '#lib/components/admin/RunHistory.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// Ages and staleness tick every second on the server's clock; the data itself is re-loaded
	// every few seconds while a run is live (slower while it isn't responding), never while hidden.
	const offset = $derived(data.serverNow - Date.now());
	const clock = serverClock(() => offset);
	const runState = $derived(data.run ? shownState(data.run, clock.now, data.staleMs) : null);
	const live = $derived(runState !== null && isLiveState(runState));
	const interval = $derived(live ? 4000 : runState === 'crashed' ? 15000 : null);
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

<svelte:head><title>Pipeline · Admin · Blueprint Atlas</title></svelte:head>

<div class="space-y-10">
	<div class="space-y-5">
		<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
			<h1 class="text-2xl font-semibold text-stone-100">Pipeline</h1>
			<p class="flex items-center gap-3 text-xs text-stone-500">
				{#if live}
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

		{#if data.run && data.failed}
			<p class="text-xs font-medium tracking-wide text-stone-500 uppercase">{live || runState === 'crashed' ? 'Current run' : 'Latest run'}</p>
			<RunDetail run={data.run} failed={data.failed} now={clock.now} staleMs={data.staleMs} heartbeatMs={data.heartbeatMs} {message} timeZone={data.timeZone} />
		{:else}
			<div class="rounded-lg border border-dashed border-stone-800 p-6 text-sm text-stone-400">
				<p class="text-stone-200">No pipeline runs yet.</p>
				<p class="mt-1">
					Start one from a terminal, e.g. <code class="rounded bg-stone-800 px-1 text-stone-200">bun run backfill --stage local --limit 100</code>. It
					shows up here within a few seconds.
				</p>
			</div>
		{/if}
	</div>

	<RunHistory
		runs={data.history.runs}
		older={data.history.older}
		newer={data.newer}
		current={data.run?.id}
		now={clock.now}
		staleMs={data.staleMs}
		timeZone={data.timeZone}
	/>
</div>
