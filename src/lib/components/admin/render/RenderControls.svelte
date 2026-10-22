<script lang="ts">
	import { enhance } from '$app/forms';
	import type { RenderRun } from '#lib/server/admin/render.js';
	import { duration } from '../metrics.js';

	/**
	 * Pause / Resume / Stop. Each sets `control`; the runner acts on it at its next heartbeat and
	 * clears it, so until then the request shows as pending (and can be withdrawn). Works without
	 * JavaScript: plain form posts, and Stop's confirmation is a <details>.
	 */
	let { run, heartbeatMs, message }: { run: RenderRun; heartbeatMs: number; message?: string } = $props();

	const pending = $derived(run.control);
	const canPause = $derived((run.state === 'running' || run.state === 'starting') && pending !== 'pause' && pending !== 'stop');
	const canResume = $derived(run.state === 'paused' && pending !== 'resume' && pending !== 'stop');
	const canStop = $derived(['starting', 'running', 'paused'].includes(run.state) && pending !== 'stop');
	const PENDING: Record<string, string> = { pause: 'Pause requested', resume: 'Resume requested', stop: 'Stop requested' };

	let busy = $state<string | null>(null);
	let confirmStop = $state<HTMLDetailsElement>();

	const button = 'rounded border px-3 py-1.5 text-sm font-medium disabled:cursor-wait disabled:opacity-60';
</script>

{#if canPause || canResume || canStop || pending}
	<form
		method="POST"
		class="flex flex-wrap items-center gap-2"
		use:enhance={({ action }) => {
			busy = action.search.replace('?/', '');
			return async ({ update }) => {
				await update({ reset: false });
				busy = null;
				if (confirmStop) confirmStop.open = false;
			};
		}}
	>
		<input type="hidden" name="id" value={run.id} />
		{#if canPause}
			<button formaction="?/pause" disabled={!!busy} class="{button} border-stone-700 bg-stone-800 text-stone-100 hover:bg-stone-700">
				{busy === 'pause' ? 'Pausing…' : 'Pause'}
			</button>
		{/if}
		{#if canResume}
			<button formaction="?/resume" disabled={!!busy} class="{button} border-emerald-700/60 bg-emerald-600/20 text-emerald-200 hover:bg-emerald-600/30">
				{busy === 'resume' ? 'Resuming…' : 'Resume'}
			</button>
		{/if}
		{#if canStop}
			<details bind:this={confirmStop} class="group relative">
				<summary
					class="{button} cursor-pointer list-none border-stone-700 text-stone-300 select-none hover:border-rose-700 hover:text-rose-200 group-open:border-rose-700 group-open:text-rose-200 [&::-webkit-details-marker]:hidden"
				>
					Stop…
				</summary>
				<div class="absolute left-0 z-10 mt-2 w-72 max-w-[calc(100vw-2rem)] space-y-3 rounded-lg border border-stone-700 bg-stone-900 p-3 shadow-xl">
					<p class="text-sm text-stone-300">
						Stop this run? The renderer finishes the pages in flight and exits. Run the same command again to carry on; rendered pages are
						never drawn again.
					</p>
					<div class="flex gap-2">
						<button formaction="?/stop" disabled={!!busy} class="{button} border-rose-700 bg-rose-600/80 text-white hover:bg-rose-600">
							{busy === 'stop' ? 'Stopping…' : 'Stop run'}
						</button>
						<button type="button" class="{button} border-stone-700 text-stone-300 hover:bg-stone-800" onclick={() => confirmStop && (confirmStop.open = false)}>
							Keep running
						</button>
					</div>
				</div>
			</details>
		{/if}
		{#if pending}
			<span class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-amber-200">
				<span class="inline-flex items-center gap-1.5 rounded bg-amber-500/10 px-2 py-1">
					<span class="size-1.5 animate-pulse rounded-full bg-amber-400" aria-hidden="true"></span>
					{PENDING[pending]} · waiting for the renderer (it checks every {duration(heartbeatMs)})
				</span>
				<button formaction="?/cancel" disabled={!!busy} class="text-xs text-stone-400 underline decoration-stone-600 hover:text-stone-200">
					{busy === 'cancel' ? 'Withdrawing…' : 'Withdraw'}
				</button>
			</span>
		{/if}
	</form>
	{#if message}<p class="mt-2 text-sm text-rose-300" role="alert">{message}</p>{/if}
{/if}
