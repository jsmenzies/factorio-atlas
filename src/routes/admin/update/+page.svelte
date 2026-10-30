<script lang="ts">
	import { deserialize } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import { PIPELINE_DEP, poll, serverClock, syncTimeZone } from '#lib/components/admin/live.svelte.js';
	import { clock as clockText, duration, int, percent } from '#lib/components/admin/metrics.js';
	import FlowBoard from '#lib/components/admin/sync/FlowBoard.svelte';
	import FlowSettings from '#lib/components/admin/sync/FlowSettings.svelte';
	import FlowStrip from '#lib/components/admin/sync/FlowStrip.svelte';
	import UpdateBox from '#lib/components/admin/sync/UpdateBox.svelte';
	import { buildFlow, nowSentence } from '#lib/components/admin/sync/flow.js';
	import { previewSteps, updateState } from '#lib/components/admin/sync/view.js';
	import type { LogProgress } from '#lib/sync-progress.js';
	import type { SyncSettings, SyncStepId } from '#lib/sync.js';
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
	const run = $derived(view?.runs[0] ?? null);
	const plan = $derived(view?.plan?.value ?? null);
	const phase = $derived(updateState(run, plan, clock.now));
	const live = $derived(phase === 'running');
	// Every 3 s while an update runs (or a render run started by hand), else every minute for the ages.
	const interval = $derived(data.busy ? 2000 : live || view?.liveRender ? 3000 : 60_000);
	poll(() => interval);
	syncTimeZone(() => data.timeZone);

	// --- the log while an update runs: its last lines and the current step's live counts (#lib/sync-progress.js)

	let logTail = $state<string | null>(null);
	let progress = $state<LogProgress | null>(null);
	const liveLog = $derived(live ? (run?.options.log ?? null) : null);
	$effect(() => {
		const log = liveLog;
		if (!log) {
			logTail = null;
			progress = null;
			return;
		}
		const load = async () => {
			const res = await fetch(`/admin/__sync/log?file=${encodeURIComponent(log)}&lines=8&progress=1`).catch(() => null);
			if (!res?.ok) return;
			const out = (await res.json()) as { tail: string; progress?: LogProgress };
			logTail = out.tail.trimEnd();
			progress = out.progress ?? null;
		};
		void load();
		const timer = setInterval(load, 3000);
		return () => clearInterval(timer);
	});

	// --- the settings, edited in place and saved as they change (the whole set each time)

	/** The settings as on the page: from the first load, then only from the controls (a poll never resets a field). */
	let draft = $state<SyncSettings | null>(null);
	$effect.pre(() => {
		if (!draft && view) draft = structuredClone(view.settings);
	});
	let save = $state<{ state: 'idle' | 'saving' | 'saved' | 'error'; at?: number; message?: string; errors: string[] }>({ state: 'idle', errors: [] });
	let inFlight = false;
	let again = false;
	const saveSettings = async () => {
		if (!draft) return;
		if (inFlight) {
			again = true;
			return;
		}
		inFlight = true;
		save = { ...save, state: 'saving' };
		try {
			const body = new FormData();
			body.set('settings', JSON.stringify($state.snapshot(draft)));
			const res = await fetch('?/save', { method: 'POST', body, headers: { 'x-sveltekit-action': 'true' } });
			const result = deserialize(await res.text());
			if (result.type === 'success') save = { state: 'saved', at: Date.now(), errors: [] };
			else if (result.type === 'failure') {
				const d = (result.data ?? {}) as { message?: string; errors?: string[] };
				save = { state: 'error', message: d.message ?? `HTTP ${res.status}`, errors: d.errors ?? [] };
			} else save = { state: 'error', message: `HTTP ${res.status}`, errors: [] };
		} catch (e) {
			save = { state: 'error', message: e instanceof Error ? e.message : String(e), errors: [] };
		} finally {
			inFlight = false;
			if (again) {
				again = false;
				void saveSettings();
			}
		}
	};

	const flow = $derived(
		view
			? buildFlow({
					plan,
					run,
					phase,
					liveRender: view.liveRender,
					progress,
					now: clock.now,
					timeZone: data.timeZone,
					clock: (at) => clockText(at, clock.now, data.timeZone)
				})
			: null
	);
	const sentence = $derived(flow ? nowSentence(flow, { plan, run, phase, liveRender: view?.liveRender ?? null }) : '');
	const preview = $derived(view && draft ? previewSteps(plan, view.scopes.union, draft) : []);

	let box = $state<UpdateBox | null>(null);
	let refreshing = $state(false);
	const refresh = async () => {
		refreshing = true;
		await invalidate(PIPELINE_DEP);
		refreshing = false;
	};
	const message = $derived(form && 'message' in form ? (form.message as string) : undefined);
</script>

<svelte:head><title>Update · Admin · Blueprint Atlas</title></svelte:head>

{#snippet renderProgress(id: SyncStepId)}
	{@const r = view?.liveRender}
	{#if id === 'render' && live && r && r.prints_total > 0}
		<div class="mt-1.5 h-2 overflow-hidden rounded-full bg-stone-800">
			<div class="h-full bg-amber-500" style="width: {percent(r.prints_done, r.prints_total)}"></div>
		</div>
		<p class="mt-1 text-xs text-stone-400 tabular-nums">
			{int(r.prints_done)} of {int(r.prints_total)} prints · {int(r.rendered)} pages drawn · {int(r.uploaded)} uploaded · {int(r.failed)} failed{r.eta_seconds
				? ` · about ${duration(r.eta_seconds * 1000)} left`
				: ''}
		</p>
	{/if}
{/snippet}

<div class="space-y-4">
	<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
		<h1 class="text-2xl font-semibold text-stone-100">Update</h1>
		<p class="flex flex-wrap items-center gap-3 text-xs text-stone-500">
			{#if save.state === 'saving'}
				<span role="status">Saving…</span>
			{:else if save.state === 'saved' && save.at}
				<span class="text-emerald-300" role="status">Settings saved {clockText(save.at, clock.now, data.timeZone)}</span>
			{:else if save.state === 'error'}
				<span class="text-rose-300" role="alert">{save.message}</span>
			{:else if view && !live}
				<span>{view.settingsSavedAt ? 'Settings save as you change them' : 'Default settings: they save as you change them'}</span>
			{/if}
			{#if data.busy}<span class="text-amber-300" role="status">Database busy (a run is writing), retrying…</span>{/if}
			<button type="button" onclick={refresh} disabled={refreshing} class="rounded border border-stone-800 px-2 py-0.5 text-stone-400 hover:text-stone-200">
				{refreshing ? 'Refreshing…' : 'Refresh'}
			</button>
		</p>
	</div>

	{#if !view || !draft || !flow}
		<div class="rounded-lg border border-dashed border-stone-800 p-6 text-sm text-stone-400">
			<p class="text-stone-200">The local database is busy (a run is writing to it); trying again in a moment.</p>
		</div>
	{:else}
		{#if view.liveRender && !live}
			<p class="rounded-lg border border-amber-500/40 p-3 text-sm text-amber-200">
				A render run started by hand is live (<a href="/admin/render" class="underline">Render runs</a>): an update can't start until it ends.
			</p>
		{/if}
		<UpdateBox bind:this={box} {run} {plan} settings={draft} union={view.scopes.union} {sentence} {logTail} now={clock.now} timeZone={data.timeZone} {message} />
		<FlowStrip {run} live={live || phase === 'crashed'} {preview} now={clock.now} extra={renderProgress} />
		<FlowBoard {flow} bind:settings={draft} onchange={saveSettings} onaccepted={() => void box?.check()} figures={view.figures?.value ?? null} now={clock.now} timeZone={data.timeZone} />
		<FlowSettings bind:settings={draft} {live} union={view.scopes.union} modern={view.scopes.modern.total} errors={save.errors} onchange={saveSettings} />
		<p class="text-xs text-stone-500">
			Detail pages: <a href="/admin/render" class="underline decoration-stone-700 hover:text-amber-300">render runs</a> ·
			<a href="/admin/pipeline" class="underline decoration-stone-700 hover:text-amber-300">backfill runs on this machine’s database</a> · past updates on the
			<a href="/admin" class="underline decoration-stone-700 hover:text-amber-300">Overview</a>
		</p>
	{/if}
</div>
