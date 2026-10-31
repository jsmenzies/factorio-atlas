<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import type { ScopeFigures } from '#lib/server/admin/render-scope.js';
	import { planTotals, SYNC_STEPS, type SyncPlan, type SyncRun, type SyncSettings } from '#lib/sync.js';
	import { PIPELINE_DEP } from '../live.svelte.js';
	import { ago, bytes, clock, duration, int } from '../metrics.js';
	import { PLAN_FRESH_MS, previewCost, unchecked, uncheckedText, updateState, upToDateLine } from './view.js';

	/**
	 * The Update tab's head: one calm sentence for what is happening now (or what an update would do), Check
	 * again and Start with the estimate, or while an update runs its step, elapsed time, Stop / Quit now and
	 * the log's latest line (the last few in a fold). The buttons call the dev-only plugin
	 * (scripts/sync/dev-plugin.ts); Stop is a form action. A source check older than PLAN_FRESH_MS is redone
	 * when the page opens, never while an update runs (its fetch step checks the sources itself).
	 */
	let {
		run,
		plan,
		settings,
		union,
		sentence,
		logTail,
		bar = null,
		now,
		timeZone,
		message
	}: {
		run: SyncRun | null;
		plan: SyncPlan | null;
		/** The settings as edited on the page (saved as they change): the estimate follows them. */
		settings: SyncSettings;
		union: ScopeFigures;
		sentence: string;
		/** The log's last lines while an update runs. */
		logTail: string | null;
		/** While a step runs and has an honest fraction (flow.ts heroBar), its progress 0–100: a thin bar under the sentence. */
		bar?: number | null;
		now: number;
		timeZone: string;
		message?: string;
	} = $props();

	const phase = $derived(updateState(run, plan, now));
	const live = $derived(phase === 'running');
	let busy = $state<'start' | 'check' | 'stop' | null>(null);
	let error = $state<string | null>(null);
	/** A neutral word, in grey (the check refused because an update is running and checks the sources itself). */
	let note = $state<string | null>(null);
	/** After Start: the update's row hasn't appeared yet. */
	let starting = $state<{ since: number; prev: string | null } | null>(null);

	const post = async (path: string, body: object = {}) => {
		const res = await fetch(`/admin/__sync/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
		const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
		if (!res.ok || !out.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
		return out;
	};

	/** Check every source again (`sync --plan`); also after a lane's Accept. */
	export const check = async () => {
		if (live) return;
		busy = 'check';
		error = null;
		note = null;
		try {
			await post('plan');
			await invalidate(PIPELINE_DEP);
		} catch (e) {
			const why = e instanceof Error ? e.message : String(e);
			// `sync --plan` refuses while an update runs: its own fetch step checks the sources. Not an error.
			if (/an update is running/.test(why)) {
				note = 'Sources are checked by the running update.';
				await invalidate(PIPELINE_DEP);
			} else error = `Couldn't check the sources: ${why}`;
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

	// Opening the page: check the sources when the last check is stale and nothing is running.
	let autoChecked = false;
	$effect(() => {
		if (autoChecked || live || phase === 'crashed' || busy) return;
		if (plan && Date.now() - plan.checkedAt < PLAN_FRESH_MS) return;
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

	const totals = $derived(planTotals(plan));
	const failed = $derived(unchecked(plan));
	const current = $derived(run?.steps.find((s) => s.status === 'running'));
	const stepNo = $derived(current ? SYNC_STEPS.findIndex((s) => s.id === current.id) + 1 : 0);
	const cost = $derived(previewCost(plan, union, settings));
	const lastLine = $derived(logTail?.trim().split('\n').at(-1) ?? null);
	const lastFailed = $derived(run && !live ? run.steps.filter((s) => s.status === 'failed').length : 0);
	const lastWarned = $derived(run && !live ? run.steps.filter((s) => s.status === 'warning').length : 0);

	const button = 'rounded-lg border px-4 py-2 text-sm font-semibold disabled:cursor-wait disabled:opacity-60';
	const primary = `${button} border-amber-500 bg-amber-500 text-stone-950 hover:bg-amber-400`;
	const secondary = `${button} border-stone-700 bg-stone-800 font-medium text-stone-100 hover:bg-stone-700`;
	const dot = $derived(
		live ? 'bg-amber-400 pulse' : phase === 'crashed' || phase === 'blocked' ? 'bg-rose-400' : phase === 'waiting' ? 'bg-amber-400' : lastFailed ? 'bg-rose-400' : lastWarned ? 'bg-amber-300' : 'bg-emerald-400'
	);
</script>

<section
	class="rounded-xl border p-4 sm:p-5 {live || phase === 'waiting' ? 'border-amber-500/40 bg-gradient-to-br from-amber-500/[0.08] to-stone-900/50' : phase === 'blocked' || phase === 'crashed' ? 'border-rose-900/70 bg-rose-950/20' : 'border-stone-800 bg-stone-900/50'}"
	aria-labelledby="update-title"
>
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="flex min-w-0 flex-1 basis-80 gap-3">
			<span class="mt-2.5 size-2.5 shrink-0 rounded-full {dot}" aria-hidden="true"></span>
			<div class="min-w-0">
				<h2 id="update-title" class="text-lg font-semibold text-stone-100 sm:text-xl">{sentence}</h2>
				<p class="mt-0.5 text-sm text-stone-400">
					{#if live && run}
						Step {stepNo} of {SYNC_STEPS.length} · {run.state === 'stopping' ? 'stopping after this step' : `running ${duration(now - run.started_at)}`} · started
						{clock(run.started_at, now, timeZone)} · to {run.stage}
					{:else if phase === 'crashed' && run}
						Its heartbeat stopped {ago(now - run.updated_at)}: its process probably ended (a restart, or killed). Start another: every step carries on from where things are.
					{:else if phase === 'blocked'}
						Every other source and step still runs. Look at the source, then Accept in its Changes cell below.
					{:else if plan}
						{#if phase === 'current'}
							{@const line = upToDateLine(plan)}
							{line.complete ? `Up to date ${line.text}` : line.text} ·
						{/if}
						Sources checked {busy === 'check' ? 'now…' : ago(now - plan.checkedAt)}{failed.length && phase !== 'current' ? ` · ${uncheckedText(failed)}` : ''}
					{:else}
						Checking the sources…
					{/if}
				</p>
				{#if live && bar !== null}
					<div class="mt-2 h-1 max-w-xl overflow-hidden rounded-full bg-stone-800" role="progressbar" aria-label="Progress of this step" aria-valuemin="0" aria-valuemax="100" aria-valuenow={bar}>
						<div class="h-full bg-amber-500 transition-[width] duration-500" style="width: {bar}%"></div>
					</div>
				{/if}
				{#if run && !live && phase !== 'crashed'}
					<p class="mt-0.5 text-xs text-stone-500">
						<a href="/admin" class="underline decoration-stone-700 hover:text-amber-300">Last update</a>: {run.state}
						{clock(run.finished_at ?? run.updated_at, now, timeZone)} · took {duration((run.finished_at ?? run.updated_at) - run.started_at)}{lastFailed
							? ` · ${lastFailed} step${lastFailed === 1 ? '' : 's'} failed`
							: ''}{lastWarned ? ` · ${lastWarned} to look at` : ''}
					</p>
				{/if}
			</div>
		</div>

		<div class="flex flex-wrap items-center gap-2">
			{#if live && run}
				{@const quit = run.control === 'stop' || run.state === 'stopping'}
				<span class="text-sm text-stone-400 tabular-nums">{duration(now - run.started_at)}</span>
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
				<button type="button" onclick={check} disabled={!!busy} class="{secondary} py-1.5 text-xs">{busy === 'check' ? 'Checking…' : 'Check again'}</button>
				<button type="button" onclick={start} disabled={!!busy || !!starting} class={phase === 'current' ? secondary : primary}>
					{busy === 'start' || starting ? 'Starting…' : 'Start update'}
				</button>
			{/if}
		</div>
	</div>

	{#if !live && phase !== 'crashed'}
		<p class="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-stone-400">
			{#if cost.pages}
				<span>Rendering <b class="font-semibold text-stone-100">≈ {duration(cost.seconds * 1000)}</b></span>
				<span>R2 uploads <b class="font-semibold text-stone-100">≈ {int(cost.puts)} · ${cost.dollars.toFixed(2)}</b></span>
				<span>Disk <b class="font-semibold text-stone-100">+{bytes(cost.bytes)}</b></span>
			{:else}
				<span>{settings.render ? 'Nothing to render: a quick update.' : 'Rendering is off: a quick update.'}</span>
			{/if}
		</p>
		{#if totals.deleted > 0}
			<p class="mt-2 text-sm text-amber-200">
				{int(totals.deleted)} print{totals.deleted === 1 ? ' was' : 's were'} deleted from factorioprints. They stay on the site.
			</p>
		{/if}
	{/if}

	{#if error}<p class="mt-3 text-sm whitespace-pre-wrap text-rose-300" role="alert">{error}</p>{/if}
	{#if note}<p class="mt-3 text-sm text-stone-400" role="status">{note}</p>{/if}
	{#if message}<p class="mt-3 text-sm text-rose-300" role="alert">{message}</p>{/if}

	{#if live && logTail}
		<details class="group mt-3 border-t border-stone-800 pt-2">
			<summary class="flex cursor-pointer list-none items-center gap-2 font-mono text-xs text-stone-400 [&::-webkit-details-marker]:hidden">
				<span class="text-stone-600 transition-transform group-open:rotate-90" aria-hidden="true">▸</span>
				<span class="shrink-0 font-sans text-stone-600">log</span>
				{#key lastLine}<span class="ticker min-w-0 truncate">{lastLine}</span>{/key}
			</summary>
			<pre class="mt-2 max-h-40 overflow-auto rounded-lg border border-stone-800 bg-stone-950 p-3 text-xs leading-relaxed whitespace-pre-wrap text-stone-400">{logTail}</pre>
		</details>
	{/if}
</section>

<style>
	.pulse {
		animation: pulse 1.6s ease-out infinite;
	}
	.ticker {
		animation: tick-in 0.4s ease both;
	}
	@keyframes pulse {
		0% {
			box-shadow: 0 0 0 0 rgb(251 191 36 / 0.6);
		}
		70% {
			box-shadow: 0 0 0 10px rgb(251 191 36 / 0);
		}
		100% {
			box-shadow: 0 0 0 0 rgb(251 191 36 / 0);
		}
	}
	@keyframes tick-in {
		from {
			opacity: 0;
			transform: translateY(3px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.pulse,
		.ticker {
			animation: none;
		}
	}
</style>
