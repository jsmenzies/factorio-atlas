<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { PIPELINE_DEP, poll, serverClock, syncTimeZone } from '#lib/components/admin/live.svelte.js';
	import Figures from '#lib/components/admin/sync/Figures.svelte';
	import SettingsSummary from '#lib/components/admin/sync/SettingsSummary.svelte';
	import SyncHistory from '#lib/components/admin/sync/SyncHistory.svelte';
	import UpdateBox from '#lib/components/admin/sync/UpdateBox.svelte';
	import { updateState } from '#lib/components/admin/sync/view.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// A load that met a locked database (a run writing) returns `busy`: keep showing the last data.
	type Loaded = Extract<PageProps['data'], { busy: false }>;
	let last: Loaded | null = null;
	const view = $derived.by(() => {
		if (!data.busy) last = data;
		return data.busy ? last : data;
	});

	const offset = $derived(data.serverNow - Date.now());
	const clock = serverClock(() => offset);
	const phase = $derived(view ? updateState(view.runs[0] ?? null, view.plan?.value ?? null, clock.now) : null);
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
	const message = $derived(form && 'message' in form ? form.message : undefined);
</script>

<svelte:head><title>Overview · Admin · Blueprint Atlas</title></svelte:head>

<div class="space-y-3">
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
		<div class="grid gap-3 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
			<UpdateBox
				run={view.runs[0] ?? null}
				plan={view.plan?.value ?? null}
				planCheckedAt={view.plan?.value.checkedAt ?? null}
				settings={view.settings}
				union={view.scopes.union}
				liveRender={view.liveRender}
				now={clock.now}
				timeZone={data.timeZone}
				{message}
			/>
			<div class="space-y-3">
				<SettingsSummary settings={view.settings} savedAt={view.settingsSavedAt} now={clock.now} timeZone={data.timeZone} />
				{#if view.liveRender && phase !== 'running'}
					<p class="rounded-lg border border-amber-500/40 p-3 text-sm text-amber-200">
						A render run started by hand is live (<a href="/admin/render" class="underline">Render</a>): an update can't start until it ends.
					</p>
				{/if}
			</div>
		</div>
		<Figures figures={view.figures?.value ?? null} plan={view.plan?.value ?? null} scopes={view.scopes} totals={view.totals} now={clock.now} timeZone={data.timeZone} />
		<SyncHistory runs={view.runs} now={clock.now} timeZone={data.timeZone} />
	{/if}
</div>
