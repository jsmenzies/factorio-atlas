<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { PIPELINE_DEP } from '../live.svelte.js';
	import type { RenderRun } from '#lib/server/admin/render.js';
	import RenderControls from './RenderControls.svelte';

	/**
	 * Start a render batch (`--next N`, optionally `--top N` so the top favourites go first) or resume the last run, from the page. Only under `vite dev`:
	 * a dev-only Vite plugin (scripts/render/dev-plugin.ts) starts the process. Pause, resume and stop
	 * set `render_runs.control`, like everywhere else.
	 */
	let {
		run,
		live,
		crashed,
		heartbeatMs,
		message,
		storedTop
	}: { run: RenderRun | null; live: boolean; crashed: boolean; heartbeatMs: number; message?: string; storedTop: number | null } = $props();

	interface Status {
		cloneDir: string;
		assetsDir: string | null;
		problems: string[];
		prodReady: boolean;
		live: { id: string; state: string } | null;
		log: string | null;
		/** The run logs' folder, in the renders folder (RENDERS_DIR). */
		logDir: string;
		/** The local database was locked by a run's writes, so `live` is unknown (null). */
		busy?: boolean;
	}

	let status = $state<Status | null>(null);
	let statusError = $state<string | null>(null);
	let next = $state(100);
	let upload = $state<'none' | 'local' | 'prod'>('none');
	let force = $state(false);
	/** `--top N`: the top-N favourites first, pre-2.0 pages included. */
	let withTop = $state(false);
	let topEdited = $state<number | null>(null);
	const top = $derived(topEdited ?? storedTop ?? 1000);
	let refreshTop = $state(false);
	/** Blank: the runner's default (half the CPU threads). */
	let workers = $state<number | null>(null);
	let busy = $state<'start' | 'resume' | null>(null);
	let waitingFor = $state<{ since: number; prev: string | null; pid?: number; log?: string } | null>(null);
	let error = $state<string | null>(null);
	let logTail = $state<{ log: string; tail: string } | null>(null);

	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	const loadStatus = async () => {
		clearTimeout(retryTimer);
		try {
			const res = await fetch('/admin/render/__control/status');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const next = (await res.json()) as Status;
			// Busy: whether a run is live is unknown; keep what was known and ask again shortly.
			status = next.busy && status ? { ...next, live: status.live } : next;
			statusError = null;
			if (next.busy) retryTimer = setTimeout(loadStatus, 2000);
			if (!status.prodReady && upload === 'prod') upload = 'none';
		} catch (e) {
			// Keep the last status (a run keeps the dev server busy); only say so when there is none yet.
			if (!status) statusError = `Can't reach the dev server's render control (${e instanceof Error ? e.message : e}).`;
			retryTimer = setTimeout(loadStatus, 5000);
		}
	};
	$effect(() => () => clearTimeout(retryTimer));
	const loadLog = async () => {
		const res = await fetch('/admin/render/__control/log?lines=40');
		logTail = res.ok ? ((await res.json()) as { log: string; tail: string }) : null;
	};
	// On load, and whenever the page sees a run start, stop or end: the dev server's view of live
	// runs (status.live) decides whether a start is allowed.
	const runKey = $derived(`${live} ${run?.id} ${run?.state}`);
	$effect(() => {
		void runKey;
		void loadStatus();
	});

	// The crashed run's last words.
	$effect(() => {
		if (crashed && !logTail) void loadLog();
	});

	// After a start: refresh until the new run's row shows up (it's written a few seconds in).
	$effect(() => {
		if (!waitingFor) return;
		// The run the start made: its row records the process id.
		if (run && run.id !== waitingFor.prev && (waitingFor.pid === undefined || run.options.pid === waitingFor.pid)) {
			waitingFor = null;
			void loadStatus();
			return;
		}
		const timer = setInterval(async () => {
			if (!waitingFor) return;
			if (Date.now() - waitingFor.since > 90_000) {
				error = 'The run started but no run row appeared within 90 s; see its log below.';
				waitingFor = null;
				await loadLog();
				return;
			}
			await invalidate(PIPELINE_DEP);
		}, 1500);
		return () => clearInterval(timer);
	});

	const startRun = async (body: Record<string, unknown>, kind: 'start' | 'resume') => {
		busy = kind;
		error = null;
		logTail = null;
		try {
			const res = await fetch('/admin/render/__control/start', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			const out = (await res.json()) as { ok?: boolean; error?: string; pid?: number; log?: string; tail?: string };
			if (!res.ok || !out.ok) {
				error = out.error ?? `HTTP ${res.status}`;
				if (out.log && out.tail !== undefined) logTail = { log: out.log, tail: out.tail };
				return;
			}
			waitingFor = { since: Date.now(), prev: run?.id ?? null, pid: out.pid, log: out.log };
			await invalidate(PIPELINE_DEP);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = null;
		}
	};

	const blocked = $derived(live || !!status?.live || !!waitingFor);
	const problems = $derived(status?.problems ?? []);
	const button = 'rounded border px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';
	const field = 'rounded border border-stone-700 bg-stone-950 px-2 py-1 text-sm text-stone-100';
</script>

<section class="space-y-3 rounded-lg border border-stone-800 bg-stone-900/50 p-4" aria-labelledby="start-batch">
	<div class="flex flex-wrap items-baseline justify-between gap-2">
		<h2 id="start-batch" class="text-lg font-semibold text-stone-100">Start a batch</h2>
		<p class="text-xs text-stone-500">Local dev server only · runs <code>bun run render --next N</code> on this machine</p>
	</div>

	{#if statusError}
		<p class="text-sm text-rose-300" role="alert">{statusError}</p>
	{:else if status}
		<p class="text-xs text-stone-500">
			Mirror clone <code class="text-stone-300">{status.cloneDir}</code>
			{#if status.assetsDir}· sprite assets <code class="text-stone-300">{status.assetsDir}</code>{/if}
			{#if status.log}· latest log <code class="text-stone-300">{status.logDir}/{status.log}</code>{/if}
		</p>
		{#each problems as p (p)}<p class="text-sm text-amber-300">{p}</p>{/each}
	{/if}

	<form
		class="flex flex-wrap items-end gap-3"
		onsubmit={(e) => {
			e.preventDefault();
			void startRun(
				{
					next,
					upload,
					...(withTop ? { top, ...(refreshTop ? { refreshTop: true } : {}) } : {}),
					...(force ? { force: true } : {}),
					...(workers ? { workers } : {})
				},
				'start'
			);
		}}
	>
		<label class="space-y-1 text-sm text-stone-300">
			<span class="block text-xs text-stone-500">Prints</span>
			<input type="number" min="1" max="100000" step="1" bind:value={next} class="{field} w-28 tabular-nums" required />
		</label>
		<label class="space-y-1 text-sm text-stone-300">
			<span class="block text-xs text-stone-500">Upload to</span>
			<select bind:value={upload} class={field}>
				<option value="none">nowhere (disk only)</option>
				<option value="local">local bucket</option>
				<option value="prod" disabled={!status?.prodReady}>prod{status && !status.prodReady ? ' (needs R2 credentials)' : ''}</option>
			</select>
		</label>
		<label class="space-y-1 text-sm text-stone-300">
			<span class="block text-xs text-stone-500">Workers</span>
			<input type="number" min="1" max="64" step="1" bind:value={workers} placeholder="default" class="{field} w-24 tabular-nums" />
		</label>
		<label class="flex items-center gap-2 pb-1.5 text-sm text-stone-300" title="--top N: the N most-favourited prints first, their pages saved before 2.0 drawn too">
			<input type="checkbox" bind:checked={withTop} class="accent-amber-500" />
			Top
			<input
				type="number"
				min="1"
				max="100000"
				step="1"
				value={top}
				oninput={(e) => (topEdited = Number(e.currentTarget.value) || null)}
				disabled={!withTop}
				class="{field} w-24 tabular-nums disabled:opacity-50"
			/>
			favourites first
		</label>
		{#if withTop}
			<label class="flex items-center gap-2 pb-1.5 text-sm text-stone-300" title="--refresh-top: recompute the list from the clone first">
				<input type="checkbox" bind:checked={refreshTop} class="accent-amber-500" />
				Refresh the list
			</label>
		{/if}
		<label class="flex items-center gap-2 pb-1.5 text-sm text-stone-300">
			<input type="checkbox" bind:checked={force} class="accent-amber-500" />
			Force (draw again)
		</label>
		<button
			type="submit"
			disabled={blocked || !!busy || problems.length > 0 || !(next >= 1)}
			class="{button} border-amber-600/70 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30"
		>
			{busy === 'start' ? 'Starting…' : `Start next ${next || '…'}`}
		</button>
		<button
			type="button"
			disabled={blocked || !!busy || !run}
			onclick={() => startRun({ resume: true }, 'resume')}
			class="{button} border-stone-700 bg-stone-800 text-stone-100 hover:bg-stone-700"
			title="A new run with the last run's options: a batch carries on with its own prints"
		>
			{busy === 'resume' ? 'Resuming…' : 'Resume last run'}
		</button>
	</form>
	{#if status && !status.prodReady}
		<p class="text-xs text-stone-500">
			Prod uploads need an R2 API token: set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in .env and restart the dev server.
		</p>
	{/if}
	<p class="text-xs text-stone-500">
		Each batch takes the next prints that still have work; rendered ones are never picked again. With Top, the top favourites with work
		come first. The run carries on if the dev server restarts.
	</p>

	{#if waitingFor}
		<p class="text-sm text-sky-300" role="status">
			Started (pid {waitingFor.pid}); waiting for the run to report in… Log: <code>{status?.logDir ?? 'logs'}/{waitingFor.log}</code>
		</p>
	{/if}
	{#if blocked && !waitingFor && (live || status?.live)}
		<p class="text-xs text-stone-500">A run is live: pause or stop it below before starting another.</p>
	{/if}
	{#if error}<p class="text-sm text-rose-300" role="alert">{error}</p>{/if}

	{#if run && live}
		<RenderControls {run} {heartbeatMs} {message} />
	{/if}

	{#if logTail}
		<details open class="rounded border border-stone-800 bg-stone-950/60">
			<summary class="cursor-pointer px-3 py-1.5 text-xs text-stone-400">Log tail · {status?.logDir ?? 'logs'}/{logTail.log}</summary>
			<pre class="max-h-80 overflow-auto px-3 pb-3 font-mono text-xs whitespace-pre-wrap text-stone-300">{logTail.tail}</pre>
		</details>
	{/if}
</section>
