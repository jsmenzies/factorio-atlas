<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import type { ScopeFigures } from '#lib/server/admin/render-scope.js';
	import type { RenderRun } from '#lib/server/admin/render.js';
	import { planTotals, stepLabel, SYNC_STEPS, type SyncPlan, type SyncRun, type SyncSettings, type SyncStepId } from '#lib/sync.js';
	import { PIPELINE_DEP } from '../live.svelte.js';
	import { ago, bytes, clock, duration, int, percent, when } from '../metrics.js';
	import StepList from './StepList.svelte';
	import {
		heldBack,
		PLAN_FRESH_MS,
		previewCost,
		previewSteps,
		shortCommit,
		sourceMoved,
		sourceState,
		unchecked,
		uncheckedText,
		updateState,
		upToDateLine
	} from './view.js';

	/**
	 * The Overview's main box: an update waiting (with what each step would do and what it costs), an
	 * update running (its steps, the render step's progress and the log's last lines, Stop), or up to
	 * date (the last update's steps). The buttons call the dev-only plugin (scripts/sync/dev-plugin.ts);
	 * Stop is a form action. A mirror check older than PLAN_FRESH_MS is redone when the page opens.
	 */
	let {
		run,
		plan,
		planCheckedAt,
		settings,
		union,
		liveRender,
		now,
		timeZone,
		message
	}: {
		run: SyncRun | null;
		plan: SyncPlan | null;
		planCheckedAt: number | null;
		settings: SyncSettings;
		union: ScopeFigures;
		liveRender: RenderRun | null;
		now: number;
		timeZone: string;
		message?: string;
	} = $props();

	const phase = $derived(updateState(run, plan, now));
	const live = $derived(phase === 'running');
	let busy = $state<'start' | 'check' | 'stop' | 'accept' | null>(null);
	let error = $state<string | null>(null);
	/** After Start: the update's row hasn't appeared yet. */
	let starting = $state<{ since: number; prev: string | null } | null>(null);
	let logTail = $state<string | null>(null);

	const post = async (path: string, body: object = {}) => {
		const res = await fetch(`/admin/__sync/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
		const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
		if (!res.ok || !out.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
		return out;
	};

	const check = async () => {
		busy = 'check';
		error = null;
		try {
			await post('plan');
			await invalidate(PIPELINE_DEP);
		} catch (e) {
			error = `Couldn't check the mirror: ${e instanceof Error ? e.message : e}`;
		} finally {
			busy = null;
		}
	};

	const start = async () => {
		busy = 'start';
		error = null;
		// Before posting: a poll during the post (it waits ≈ 4 s) may already bring the new row.
		const prev = run?.id ?? null;
		try {
			await post('start');
			starting = { since: Date.now(), prev };
			await invalidate(PIPELINE_DEP);
		} catch (e) {
			error = `The update didn't start: ${e instanceof Error ? e.message : e}`;
		} finally {
			busy = null;
		}
	};

	// Opening the page: check the mirror when the last check is stale and nothing is running.
	let autoChecked = false;
	$effect(() => {
		if (autoChecked || live || busy) return;
		if (planCheckedAt !== null && Date.now() - planCheckedAt < PLAN_FRESH_MS) return;
		autoChecked = true;
		void check();
	});

	// After Start, refresh until the update's row shows up (it's written at once; 60 s is plenty).
	$effect(() => {
		if (!starting) return;
		if (run && run.id !== starting.prev) {
			starting = null;
			return;
		}
		const timer = setInterval(() => {
			if (starting && Date.now() - starting.since > 60_000) {
				error = 'The update started but its row never appeared: see sync-console.log in the run logs folder.';
				starting = null;
			} else void invalidate(PIPELINE_DEP);
		}, 1500);
		return () => clearInterval(timer);
	});

	// The log's last lines while an update runs (keyed on the file, not the polled run object).
	const liveLog = $derived(live ? run?.options.log : null);
	$effect(() => {
		const log = liveLog;
		if (!log) {
			logTail = null;
			return;
		}
		const load = async () => {
			const res = await fetch(`/admin/__sync/log?file=${encodeURIComponent(log)}&lines=6`).catch(() => null);
			if (res?.ok) logTail = ((await res.json()) as { tail: string }).tail.trimEnd();
		};
		void load();
		const timer = setInterval(load, 4000);
		return () => clearInterval(timer);
	});

	const totals = $derived(planTotals(plan));
	const held = $derived(heldBack(plan));
	const failed = $derived(unchecked(plan));
	const current = $derived(run?.steps.find((s) => s.status === 'running'));
	const stepNo = $derived(current ? SYNC_STEPS.findIndex((s) => s.id === current.id) + 1 : 0);
	const preview = $derived(previewSteps(plan, union, settings));
	const cost = $derived(previewCost(plan, union, settings));
	const runSteps = $derived(run ? run.steps.map((s) => ({ ...s, text: s.summary })) : []);

	const button = 'rounded-lg border px-4 py-2 text-sm font-semibold disabled:cursor-wait disabled:opacity-60';
	const primary = `${button} border-amber-500 bg-amber-500 text-stone-950 hover:bg-amber-400`;
	const secondary = `${button} border-stone-700 bg-stone-800 font-medium text-stone-100 hover:bg-stone-700`;
	const card = 'rounded-lg border p-4';
</script>

{#snippet renderProgress(id: SyncStepId)}
	{#if id === 'render' && live && current?.id === 'render' && liveRender && liveRender.prints_total > 0}
		<div class="mt-1.5 h-2 overflow-hidden rounded-full bg-stone-800">
			<div class="h-full bg-amber-500" style="width: {percent(liveRender.prints_done, liveRender.prints_total)}"></div>
		</div>
		<p class="mt-1 text-xs text-stone-400 tabular-nums">
			{int(liveRender.prints_done)} of {int(liveRender.prints_total)} prints · {int(liveRender.rendered)} pages drawn · {int(liveRender.uploaded)} uploaded ·
			{int(liveRender.failed)} failed{liveRender.eta_seconds ? ` · about ${duration(liveRender.eta_seconds * 1000)} left` : ''}
		</p>
	{/if}
{/snippet}

<section
	class="{card} {phase === 'waiting' || live ? 'border-amber-500/40 bg-gradient-to-b from-amber-500/[0.07] to-stone-900/50' : 'border-stone-800 bg-stone-900/50'}"
	aria-labelledby="update-title"
>
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="min-w-0">
			{#if live && run}
				<p class="text-xs font-semibold tracking-wide text-stone-500 uppercase">
					Update · {run.state === 'stopping' ? 'stopping after this step' : `running ${duration(now - run.started_at)}`}
				</p>
				<h2 id="update-title" class="text-lg font-semibold text-stone-100">
					{current ? `Step ${stepNo} of ${SYNC_STEPS.length}: ${stepLabel(current.id).toLowerCase()}` : 'Starting'}
				</h2>
				<p class="text-xs text-stone-500">
					{#each run.sources as s (s.site)}
						{#if s.ingestsItself || s.polled}
							{s.site} ·
						{:else}
							{s.site} <code>{shortCommit(s.from?.id)}{s.to && s.to.id !== s.from?.id ? ` → ${shortCommit(s.to.id)}` : ''}</code> ·
						{/if}
					{/each}
					started {clock(run.started_at, now, timeZone)} · to {run.stage}
				</p>
			{:else if phase === 'crashed' && run}
				<p class="text-xs font-semibold tracking-wide text-stone-500 uppercase">Update · not responding</p>
				<h2 id="update-title" class="text-lg font-semibold text-rose-300">The update stopped responding {ago(now - run.updated_at)}</h2>
				<p class="text-sm text-stone-400">
					Its process probably ended (a restart, or killed). Start another: every step carries on from where things are.
				</p>
			{:else if phase === 'blocked' && plan}
				<p class="text-xs font-semibold tracking-wide text-stone-500 uppercase">Update · a source held back</p>
				<h2 id="update-title" class="text-lg font-semibold text-amber-200">
					{held.map((p) => p.site).join(', ')}: its latest update won't be fetched until you accept it
				</h2>
				{#each held as p (p.site)}
					<p class="text-sm text-stone-400">{p.site} <code>{shortCommit(p.to.id)}</code>: {p.blocked}</p>
				{/each}
				<p class="text-xs text-stone-500">
					Every other step still runs. Accept only after looking at the source (the mirror on GitHub, or the site).{failed.length
						? ` Also: ${uncheckedText(failed)}.`
						: ''}
				</p>
			{:else if phase === 'waiting' && plan}
				<p class="text-xs font-semibold tracking-wide text-stone-500 uppercase">Update</p>
				<h2 id="update-title" class="text-lg font-semibold text-stone-100">
					Something new to fetch: {[
						...(totals.backfill ? [`${int(totals.added)} new print${totals.added === 1 ? '' : 's'}`] : []),
						...(totals.waiting ? [`${int(totals.waiting)} upload${totals.waiting === 1 ? '' : 's'} waiting`] : []),
						...(totals.polled ? [`${int(totals.polled)} from other sites`] : [])
					].join(', ') || 'new names to put on uploads'}
				</h2>
				<p class="text-xs text-stone-500">
					Sources checked {ago(now - plan.checkedAt)}{failed.length ? ` · ${uncheckedText(failed)}` : ''}
				</p>
			{:else}
				<p class="text-xs font-semibold tracking-wide text-stone-500 uppercase">Update</p>
				<h2 id="update-title" class="text-lg font-semibold text-stone-100">
					{#if plan}
						{@const line = upToDateLine(plan)}
						{#if line.complete}
							<span class="text-emerald-300">Up to date</span> {line.text}
						{:else}
							<span class="text-amber-200">{line.text}</span>
						{/if}
					{:else}
						Not checked yet
					{/if}
				</h2>
				<p class="text-xs text-stone-500">
					{#if plan}
						Sources checked {busy === 'check' ? 'now…' : ago(now - plan.checkedAt)}
					{:else}
						Checking the sources…
					{/if}
				</p>
			{/if}
		</div>

		<div class="flex flex-wrap items-center gap-2">
			{#if live && run}
				{@const quit = run.control === 'stop' || run.state === 'stopping'}
				{#if run.control === 'quit'}
					<span class="text-sm text-stone-400" role="status">Quitting…</span>
				{:else}
					{#if run.control === 'stop' && run.state !== 'stopping'}
						<span class="text-sm text-stone-400" role="status">Stop requested…</span>
					{/if}
					<form
						method="POST"
						action="?/stop"
						use:enhance={() => {
							busy = 'stop';
							return async ({ update }) => {
								await update({ reset: false });
								busy = null;
							};
						}}
					>
						<input type="hidden" name="id" value={run.id} />
						<input type="hidden" name="how" value={quit ? 'quit' : 'stop'} />
						<button
							disabled={!!busy}
							class="{button} border-rose-900 py-1.5 font-medium text-rose-300 hover:bg-rose-950/50"
							title={quit ? 'The step is taking a while to stop: end it at once (as Ctrl-C twice)' : 'Finish the current step cleanly and start no more'}
						>
							{busy === 'stop' ? 'Stopping…' : quit ? 'Quit now' : 'Stop'}
						</button>
					</form>
				{/if}
			{:else}
				{#if phase === 'blocked'}
					{#each held as p (p.site)}
						<form
							method="POST"
							action="?/accept"
							use:enhance={() => {
								busy = 'accept';
								return async ({ result, update }) => {
									await update({ reset: false });
									busy = null;
									if (result.type === 'success') void check();
								};
							}}
						>
							<input type="hidden" name="site" value={p.site} />
							<input type="hidden" name="id" value={p.to.id} />
							<button disabled={!!busy} class="{secondary} py-1.5 text-xs" title="Fetch this update anyway in the next update">
								{busy === 'accept' ? 'Accepting…' : `Accept ${p.site} ${shortCommit(p.to.id)}`}
							</button>
						</form>
					{/each}
				{/if}
				<button type="button" onclick={start} disabled={!!busy || !!starting} class={phase === 'current' ? secondary : primary}>
					{busy === 'start' || starting ? 'Starting…' : 'Update everything'}
				</button>
				<button type="button" onclick={check} disabled={!!busy} class="{secondary} py-1.5 text-xs">
					{busy === 'check' ? 'Checking…' : phase === 'current' ? 'Check for updates' : 'Check again'}
				</button>
			{/if}
		</div>
	</div>

	{#if !live && plan?.sources.length}
		<!-- Where the prints come from: one row per source; a source whose cursor isn't a commit (uploads) words its own line. -->
		<ul class="mt-3 divide-y divide-stone-800/70 rounded-md border border-stone-800 bg-stone-950/60 text-sm" aria-label="Sources">
			{#each plan.sources as p (p.site)}
				{@const state = sourceState(p)}
				<li class="grid gap-x-4 gap-y-0.5 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
					<div class="min-w-0">
						<p class="truncate" title={p.kind ? `${p.site} · ${p.kind}` : p.site}>
							<span class="font-medium text-stone-100">{p.site}</span>
							{#if p.kind}<span class="text-stone-500"> · {p.kind}</span>{/if}
						</p>
						<p class="text-xs text-stone-500">
							{#if p.error}
								{p.error}
							{:else if p.position}
								{p.position}
							{:else if sourceMoved(p)}
								this machine <code>{shortCommit(p.from.id)}</code> ({when(p.from.date, now, timeZone)}) · latest <code>{shortCommit(p.to.id)}</code>
								({when(p.to.date, now, timeZone)})
							{:else}
								at <code>{shortCommit(p.to.id)}</code> · last change {when(p.to.date, now, timeZone)}
							{/if}
						</p>
					</div>
					<p
						class="text-sm sm:text-right {state.tone === 'ok'
							? 'text-emerald-300'
							: state.tone === 'warn'
								? 'text-amber-200'
								: state.tone === 'off'
									? 'text-stone-500'
									: 'text-rose-300'}"
					>
						{state.text}
					</p>
				</li>
			{/each}
		</ul>
	{/if}

	{#if error}<p class="mt-3 text-sm whitespace-pre-wrap text-rose-300" role="alert">{error}</p>{/if}
	{#if message}<p class="mt-3 text-sm text-rose-300" role="alert">{message}</p>{/if}

	{#if live || phase === 'crashed'}
		<div class="mt-4"><StepList steps={runSteps} {now} extra={renderProgress} /></div>
		{#if logTail}
			<pre class="mt-3 overflow-x-auto rounded-lg border border-stone-800 bg-stone-950 p-3 text-xs leading-relaxed text-stone-400">{logTail}</pre>
		{/if}
	{:else if phase === 'waiting' || phase === 'blocked'}
		<div class="mt-4"><StepList steps={preview} {now} /></div>
		{#if phase === 'waiting'}
			<p class="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-stone-400">
				<span>Rendering <b class="font-semibold text-stone-100">≈ {duration(cost.seconds * 1000)}</b></span>
				<span>R2 uploads <b class="font-semibold text-stone-100">≈ {int(cost.puts)} · ${cost.dollars.toFixed(2)}</b></span>
				<span>Disk <b class="font-semibold text-stone-100">+{bytes(cost.bytes)}</b></span>
			</p>
			{#if totals.deleted > 0}
				<p class="mt-2 text-sm text-amber-200">
					{int(totals.deleted)} print{totals.deleted === 1 ? ' was' : 's were'} deleted from their source. They stay on the site: deletions aren't handled yet.
				</p>
			{/if}
		{/if}
	{:else if run}
		<p class="mt-4 text-xs font-semibold tracking-wide text-stone-500 uppercase">
			Last update · {run.state} {run.finished_at ? clock(run.finished_at, now, timeZone) : ''} · took {duration((run.finished_at ?? run.updated_at) - run.started_at)}
		</p>
		<div class="mt-2"><StepList steps={runSteps} {now} /></div>
	{/if}
	{#if !live && phase === 'current' && union.left > 0}
		<p class="mt-3 text-sm text-stone-400">
			{int(union.left)} print{union.left === 1 ? '' : 's'} left to render: an update renders
			{settings.perUpdate === null ? 'them all' : `up to ${int(settings.perUpdate)}`}.
		</p>
	{/if}
</section>
