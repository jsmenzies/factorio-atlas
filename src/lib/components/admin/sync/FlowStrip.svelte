<script lang="ts">
	import type { Snippet } from 'svelte';
	import { stepLabel, SYNC_STEPS, type SyncRun, type SyncStepId } from '#lib/sync.js';
	import { duration } from '../metrics.js';
	import StepList from './StepList.svelte';
	import { STEP_MARK, type PreviewStep } from './view.js';

	/**
	 * The update's seven steps in a row, the running one pulsing. A step opens its figures below (every
	 * DetailGroup row it recorded, its summary, its render run link), or with no update to show, what it would
	 * do now. Opens by itself on the running step, else on the first that failed or needs a look.
	 */
	let {
		run,
		live,
		preview,
		now,
		extra
	}: { run: SyncRun | null; live: boolean; preview: PreviewStep[]; now: number; extra?: Snippet<[SyncStepId]> } = $props();

	let picked = $state<SyncStepId | null | undefined>(undefined);
	// Live: the running step once it has something to show (its figures, or the render run's progress).
	const auto = $derived(
		live
			? (run?.steps.find((s) => s.status === 'running' && (s.id === 'render' || s.details?.length))?.id ?? null)
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
		<div class="rounded-lg border border-stone-800 bg-stone-900/50 px-3 pt-1 pb-2">
			{#if openStep.step}
				<StepList steps={[{ ...openStep.step, text: openStep.step.summary }]} {now} {extra} />
				<!-- StepList shows the summary of a step without figures, or that failed or warned; the rest get it here. -->
				{#if openStep.step.summary && openStep.step.details?.length && openStep.step.status !== 'failed' && openStep.step.status !== 'warning'}
					<p class="text-xs break-words text-stone-500">{openStep.step.summary}</p>
				{/if}
			{/if}
			{#if !live && openStep.plan}
				<!-- What this step would do in an update started now (the last check and the settings on the page). -->
				<p class="border-t border-stone-800 py-1.5 text-sm text-stone-400">
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
