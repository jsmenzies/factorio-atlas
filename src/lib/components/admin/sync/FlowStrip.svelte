<script lang="ts">
	import { stepLabel, SYNC_STEPS, type SyncRun, type SyncStepId } from '#lib/sync.js';
	import { duration } from '../metrics.js';
	import { stepLine, type Flow } from './flow.js';
	import StepList from './StepList.svelte';
	import { STEP_MARK, type PreviewStep } from './view.js';

	/**
	 * The update's seven steps in a row, the running one pulsing. A step opens its detail bar below: one slim bar
	 * while it has a count and one sentence (what it does now, or how it ended; the board shows the figures per
	 * source), its time and render run link, and its recorded figures folded away; or with no update to show,
	 * what it would do now. Opens by itself on the running step, else on the first that failed or needs a look.
	 */
	let {
		run,
		live,
		preview,
		now,
		flow,
		sentence
	}: { run: SyncRun | null; live: boolean; preview: PreviewStep[]; now: number; flow: Flow; sentence: string } = $props();

	let picked = $state<SyncStepId | null | undefined>(undefined);
	// Live: the running step; else the first that failed or needs a look.
	const auto = $derived(
		live
			? (run?.steps.find((s) => s.status === 'running')?.id ?? null)
			: (run?.steps.find((s) => s.status === 'failed' || s.status === 'warning')?.id ?? null)
	);
	const open = $derived(picked === undefined ? auto : picked);
	const steps = $derived(SYNC_STEPS.map(({ id }, i) => ({ id, i, step: run?.steps.find((s) => s.id === id) ?? null, plan: preview.find((p) => p.id === id) })));
	const openStep = $derived(steps.find((s) => s.id === open));
</script>

<nav aria-label="Steps" class="space-y-2">
	<ol class="strip">
		{#each steps as s (s.id)}
			{@const status = s.step?.status ?? null}
			{@const mark = status ? STEP_MARK[status] : null}
			<li class={status ?? 'plan'}>
				<button
					type="button"
					aria-expanded={open === s.id}
					onclick={() => (picked = open === s.id ? null : s.id)}
					title={[s.step?.summary, !live && s.plan ? `Next update: ${s.plan.text}` : ''].filter(Boolean).join('\n')}
					class="group flex w-full flex-col items-center gap-1 rounded-md px-1 pt-0.5 pb-1 text-center {open === s.id ? 'bg-stone-800/60' : 'hover:bg-stone-900'}"
				>
					<span class="dot grid size-7 place-items-center rounded-full border text-xs font-bold {mark && status !== 'running' ? mark.class : 'border-stone-700 bg-stone-900 text-stone-400'}">
						{#if status === 'running'}<span class="spinner" aria-label="Running"></span>{:else if mark?.mark}{mark.mark}{:else}{s.i + 1}{/if}
					</span>
					<span class="text-xs leading-tight {status === 'running' ? 'font-semibold text-stone-100' : status === 'pending' || !status ? 'text-stone-500' : 'text-stone-300'}">{stepLabel(s.id)}</span>
					{#if s.step?.startedAt && (s.step.finishedAt || status === 'running')}
						<span class="text-[0.68rem] text-stone-500 tabular-nums">{duration((s.step.finishedAt ?? now) - s.step.startedAt)}</span>
					{/if}
				</button>
			</li>
		{/each}
	</ol>
	{#if openStep}
		<div class="rounded-lg border border-stone-800 bg-stone-900/50 px-3 py-2">
			{#if openStep.step}
				{@const s = openStep.step}
				{@const mark = STEP_MARK[s.status]}
				{@const line = stepLine(flow, s, sentence)}
				<div class="flex items-start gap-3">
					<span class="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md text-xs font-bold {s.status === 'running' ? 'bg-amber-500/15' : mark.class}" title={mark.label}>
						{#if s.status === 'running'}<span class="spinner" aria-label="Running"></span>{:else}{mark.mark}{/if}
					</span>
					<div class="min-w-0 flex-1">
						<p class="flex flex-wrap items-baseline justify-between gap-x-3">
							<span class="text-sm font-medium text-stone-100">{stepLabel(s.id)}</span>
							<span class="text-xs whitespace-nowrap text-stone-500 tabular-nums">
								{#if s.startedAt && (s.finishedAt || s.status === 'running')}{duration((s.finishedAt ?? now) - s.startedAt)}{/if}
								{#if s.id === 'render' && s.runId}
									· <a href="/admin/render/{s.runId}" class="text-stone-400 underline decoration-stone-600 hover:text-amber-300">render run</a>
								{/if}
							</span>
						</p>
						{#if line.bar !== null}
							<div class="mt-1.5 h-[5px] overflow-hidden rounded-full bg-stone-800" aria-hidden="true">
								<div class="h-full bg-amber-500 transition-[width] duration-500" style="width: {line.bar}%"></div>
							</div>
						{/if}
						<p class="mt-1 text-xs break-words tabular-nums {line.tone === 'bad' ? 'text-rose-300' : line.tone === 'warn' ? 'text-amber-200' : 'text-stone-400'}">
							<b class="font-semibold text-stone-200">{line.lead}</b>{line.rest ? `: ${line.rest}` : ''}
						</p>
						{#if s.details?.length && s.status !== 'running'}
							<details class="mt-1 text-xs text-stone-500">
								<summary class="cursor-pointer select-none hover:text-stone-300">All its figures</summary>
								<StepList steps={[s]} {now} bare />
							</details>
						{/if}
					</div>
				</div>
			{/if}
			{#if !live && openStep.plan}
				<!-- What this step would do in an update started now (the last check and the settings on the page). -->
				<p class="text-sm text-stone-400 {openStep.step ? 'mt-2 border-t border-stone-800 pt-1.5' : ''}">
					<span class="text-stone-200">{openStep.step ? 'Next update' : stepLabel(openStep.id)}:</span>
					{openStep.plan.text}
				</p>
			{/if}
		</div>
	{/if}
</nav>

<style>
	.strip {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.strip li {
		position: relative;
		min-width: 0;
	}
	.strip li::before {
		content: '';
		position: absolute;
		top: 1.05rem;
		left: calc(-50% + 1rem);
		right: calc(50% + 1rem);
		height: 2px;
		background: #44403c;
	}
	.strip li:first-child::before {
		display: none;
	}
	.strip li.done::before,
	.strip li.warning::before,
	.strip li.failed::before,
	.strip li.running::before,
	.strip li.skipped::before {
		background: #b45309;
	}
	.strip li.running .dot {
		border-color: #f59e0b;
		animation: ring 1.6s ease-out infinite;
	}
	.spinner {
		width: 0.85rem;
		height: 0.85rem;
		border-radius: 999px;
		border: 2px solid rgb(245 158 11 / 0.3);
		border-top-color: #fbbf24;
		animation: spin 0.9s linear infinite;
	}
	@keyframes ring {
		0% {
			box-shadow: 0 0 0 0 rgb(245 158 11 / 0.55);
		}
		70% {
			box-shadow: 0 0 0 9px rgb(245 158 11 / 0);
		}
		100% {
			box-shadow: 0 0 0 0 rgb(245 158 11 / 0);
		}
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (max-width: 640px) {
		.strip {
			grid-template-columns: repeat(4, minmax(0, 1fr));
			row-gap: 0.5rem;
		}
		.strip li:nth-child(5)::before {
			display: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.strip li.running .dot,
		.spinner {
			animation: none;
		}
	}
</style>
