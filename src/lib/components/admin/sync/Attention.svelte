<script lang="ts">
	import type { RenderTotals } from '#lib/server/admin/sync.js';
	import { figureAttention } from './site-figures.js';
	import type { SyncFigures, SyncPlan, SyncRun } from '#lib/sync.js';
	import { ago, int } from '../metrics.js';
	import { heldBack, unchecked, updateState } from './view.js';

	/**
	 * The Overview's "needs a look": the stage's queues (open removal requests, upload screenshots to
	 * approve, accounts being deleted, uploads still processing, as last counted: sync_meta 'figures'),
	 * failed render pages (the local queue) and the update itself (one that stopped responding or failed
	 * a step, a source held back or not reachable), and the figures' own gaps past a threshold (site-figures.ts
	 * figureAttention: prints with no author, waiting to render, unreadable posts, unused screenshot copies). Each links
	 * to where it is dealt with.
	 */
	let {
		figures,
		plan,
		run,
		totals,
		waiting,
		now
	}: { figures: SyncFigures | null; plan: SyncPlan | null; run: SyncRun | null; totals: RenderTotals; waiting: number; now: number } = $props();

	const a = $derived(figures?.attention);
	const phase = $derived(updateState(run, plan, now));
	const failedSteps = $derived(run && phase !== 'running' ? run.steps.filter((s) => s.status === 'failed').length : 0);
	const sourceIssues = $derived([...heldBack(plan).map((p) => `${p.site} held back`), ...unchecked(plan).map((p) => `${p.site} couldn’t be checked`)]);

	const items = $derived([
		{ label: 'Removal requests open', n: a?.reports, href: '/admin/reports' },
		{ label: 'Upload screenshots to approve', n: a?.screenshots, href: '/admin/screenshots' },
		{ label: 'Accounts being deleted', n: a?.deleting, href: '/admin/accounts' },
		{ label: 'Uploads still processing', n: a?.processing, href: '/admin/update' },
		{ label: 'Render pages failed', n: totals.failed, href: '/admin/render' },
		...figureAttention(figures, waiting).map((f) => ({ label: f.label, n: f.n, href: f.href, flag: f.flag, detail: f.detail }))
	] as { label: string; n: number | undefined; href: string; flag?: boolean; detail?: string }[]);
	const update = $derived(
		phase === 'running'
			? { text: 'An update is running', tone: 'run' }
			: phase === 'crashed'
				? { text: 'The last update stopped responding', tone: 'bad' }
				: failedSteps
					? { text: `The last update had ${failedSteps} failed step${failedSteps === 1 ? '' : 's'}`, tone: 'bad' }
					: sourceIssues.length
						? { text: sourceIssues.join(' · '), tone: 'warn' }
						: null
	);
</script>

<section aria-labelledby="attention-title" class="space-y-2">
	<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
		<h2 id="attention-title" class="text-xs font-semibold tracking-wide text-stone-500 uppercase">Needs a look</h2>
		<p class="text-xs text-stone-500">{a && figures ? `Queues as counted on ${figures.stage} ${ago(now - figures.at)}` : 'Queues are counted at the end of the next update'}</p>
	</div>
	{#if update}
		<a
			href="/admin/update"
			class="flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-sm {update.tone === 'bad'
				? 'border-rose-900 bg-rose-950/30 text-rose-200'
				: update.tone === 'run'
					? 'border-amber-500/40 bg-amber-500/[0.07] text-amber-200'
					: 'border-amber-900/70 bg-amber-950/20 text-amber-200'} hover:border-amber-400"
		>
			<span>{update.text}</span><span aria-hidden="true">→</span>
		</a>
	{/if}
	<ul class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
		{#each items as it (it.label)}
			<li>
				<a
					href={it.href}
					class="flex h-full flex-col rounded-lg border px-3 py-2 hover:border-amber-400/60 {(it.flag ?? it.n)
						? 'border-amber-700/60 bg-amber-950/20'
						: 'border-stone-800 bg-stone-900/50'}"
				>
					<span class="text-xl font-semibold tabular-nums {(it.flag ?? it.n) ? 'text-amber-200' : it.n ? 'text-stone-300' : it.n === 0 ? 'text-stone-500' : 'text-stone-600'}">
						{it.n === undefined ? '—' : it.n === 0 ? 'none' : int(it.n)}
					</span>
					<span class="text-xs text-stone-400">{it.label}</span>
					{#if it.detail}<span class="text-xs text-stone-500">{it.detail}</span>{/if}
				</a>
			</li>
		{/each}
	</ul>
</section>
