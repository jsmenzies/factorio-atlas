<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SyncFigures, SyncSettings } from '#lib/sync.js';
	import { int, when } from '../metrics.js';
	import type { Flow, Lane, Stage } from './flow.js';
	import Toggle from './Toggle.svelte';
	import { shortCommit, sourceMoved } from './view.js';

	/**
	 * The Update tab's flow board: one lane per source through Waiting → Read → Gate, merging into the shared
	 * Screenshots (three inputs, one sizing and upload) and Render stages, then the site's totals. Dots travel
	 * along the pipe into the stage working now (none under reduced motion). The polled sites' switches sit on
	 * their lanes (bound settings, saved by the page on `onchange`); Accept sits on a held-back lane. Built from
	 * `flow` (flow.ts), so every figure is the update's own; a figure not recorded per source is shown once, on
	 * the shared stage.
	 */
	let {
		flow,
		settings = $bindable(),
		onchange,
		onaccepted,
		figures,
		now,
		timeZone
	}: {
		flow: Flow;
		settings: SyncSettings;
		onchange: () => void;
		onaccepted: () => void;
		figures: SyncFigures | null;
		now: number;
		timeZone: string;
	} = $props();

	const HUE: Record<string, string> = { factorioprints: '#f59e0b', codex: '#38bdf8', fprints: '#a78bfa', uploads: '#34d399' };
	const hue = (site: string) => HUE[site] ?? '#a8a29e';
	let accepting = $state(false);

	const flowing = (s: Stage) => s.state === 'active';
	const reached = (s: Stage) => s.state === 'active' || s.state === 'done' || s.state === 'warn' || s.state === 'bad';
	const ICON: Partial<Record<Stage['state'], string>> = { done: '✓', warn: '!', bad: '✗', held: '‖', off: '–' };
	/** Where a source stands, for the Waiting node's small print (and its tooltip). */
	const position = (l: Lane) => {
		const p = l.plan;
		if (!p || p.error) return '';
		if (p.position) return p.position;
		return sourceMoved(p)
			? `this machine ${shortCommit(p.from.id)} (${when(p.from.date, now, timeZone)}) · latest ${shortCommit(p.to.id)} (${when(p.to.date, now, timeZone)})`
			: `at ${shortCommit(p.to.id)} · last change ${when(p.to.date, now, timeZone)}`;
	};
	const sitesShots = $derived(flow.shots.inputs.find((i) => i.key === 'sites'));
</script>

{#snippet bar(value: number, of: number, color: string)}
	<div class="mt-1 h-1.5 overflow-hidden rounded-full bg-stone-800">
		<div class="h-full rounded-full transition-[width] duration-500" style="width: {Math.min(100, (value / Math.max(1, of)) * 100)}%; background: {color}"></div>
	</div>
{/snippet}

{#snippet node(st: Stage, label: string, color: string, extra?: string)}
	<div class="node {st.state}" style="--c: {color}" title={extra}>
		<p class="flex items-center gap-1.5 text-[0.68rem] font-semibold tracking-wide text-stone-500 uppercase">
			{#if st.state === 'active'}<span class="spinner" aria-hidden="true"></span>{:else if ICON[st.state]}<span class="mark {st.state}">{ICON[st.state]}</span>{/if}
			{label}
		</p>
		{#if (st.value ?? 0) > 0 || (st.of && st.state !== 'todo')}
			<p class="text-xl leading-tight font-semibold text-stone-100 tabular-nums">
				{int(st.value ?? 0)}{#if st.of}<small class="text-xs font-normal text-stone-500"> / {int(st.of)}</small>{/if}
			</p>
		{/if}
		{#if st.outcome}
			{@const o = st.outcome}
			{@const total = Math.max(1, o.of)}
			<div class="mt-1 flex h-1.5 overflow-hidden rounded-full bg-stone-800" role="img" aria-label="{o.new} new, {o.joined} joined, {o.unreadable} unreadable, {o.failed} failed">
				<span class="bg-emerald-400" style="width: {(o.new / total) * 100}%"></span>
				<span class="bg-sky-400" style="width: {(o.joined / total) * 100}%"></span>
				<span class="bg-stone-400" style="width: {(o.other / total) * 100}%"></span>
				<span class="bg-amber-500" style="width: {(o.unreadable / total) * 100}%"></span>
				<span class="bg-rose-400" style="width: {(o.failed / total) * 100}%"></span>
			</div>
			<p class="mt-1 flex flex-wrap gap-x-2.5 text-xs text-stone-400">
				<span><b class="font-semibold text-emerald-300 tabular-nums">{int(o.new)}</b> new</span>
				<span><b class="font-semibold text-sky-300 tabular-nums">{int(o.joined)}</b> joined</span>
				{#if o.other}<span><b class="font-semibold text-stone-200 tabular-nums">{int(o.other)}</b> updated or unchanged</span>{/if}
				{#if o.suggest}<span><b class="font-semibold text-violet-300 tabular-nums">{int(o.suggest)}</b> with suggestions</span>{/if}
				{#if o.unreadable}<span><b class="font-semibold text-amber-300 tabular-nums">{int(o.unreadable)}</b> unreadable</span>{/if}
				{#if o.failed}<span><b class="font-semibold text-rose-300 tabular-nums">{int(o.failed)}</b> failed</span>{/if}
			</p>
		{:else if st.of && st.state === 'active'}
			{@render bar(st.value ?? 0, st.of, color)}
		{/if}
		{#if st.text}<p class="mt-0.5 text-xs break-words {st.state === 'bad' ? 'text-rose-300' : st.state === 'held' ? 'text-rose-200' : 'text-stone-400'}">{st.text}</p>{/if}
		{#if st.figs?.length}
			<p class="mt-0.5 flex flex-wrap gap-x-2.5 text-xs text-stone-500">
				{#each st.figs as f, i (i)}
					<span>{f.label} <b class="font-semibold tabular-nums {f.tone === 'bad' ? 'text-rose-300' : f.tone === 'warn' ? 'text-amber-200' : 'text-stone-300'}">{typeof f.value === 'number' ? int(f.value) : f.value}</b></span>
				{/each}
			</p>
		{/if}
	</div>
{/snippet}

{#snippet pipe(down: Stage, color: string)}
	<div class="pipe {reached(down) ? 'filled' : ''} {flowing(down) ? 'flowing' : ''}" style="--c: {color}" aria-hidden="true"><span></span></div>
{/snippet}

{#snippet who(l: Lane, ids: boolean)}
	<div class="flex min-w-0 items-start gap-2.5">
		{#if l.toggle && !flow.live}
			<Toggle bind:checked={settings.polled[l.toggle].on} id={ids ? `polled-${l.toggle}-on` : undefined} label="Fetch prints from {l.host}" {onchange} />
		{/if}
		<div class="min-w-0">
			<p class="font-medium text-stone-100">{l.site}</p>
			<p class="text-xs break-words text-stone-500" title={l.kind ? `${l.host} · ${l.kind}` : l.host}>{l.host}</p>
			<p class="mt-0.5 text-[0.68rem] text-stone-500">{l.via}</p>
		</div>
	</div>
{/snippet}

{#snippet held(l: Lane)}
	{#if l.plan?.blocked && !flow.live}
		<div class="rounded-md border border-rose-900/70 bg-rose-950/40 p-2.5 text-sm">
			<p class="text-rose-200">⚠ Held back, not fetched until accepted: {l.plan.blocked}</p>
			<form
				method="POST"
				action="?/accept"
				class="mt-2"
				use:enhance={() => {
					accepting = true;
					return async ({ result, update }) => {
						await update({ reset: false });
						accepting = false;
						if (result.type === 'success') onaccepted();
					};
				}}
			>
				<input type="hidden" name="site" value={l.plan.site} />
				<input type="hidden" name="id" value={l.plan.to.id} />
				<button
					disabled={accepting}
					class="rounded-lg border border-stone-700 bg-stone-800 px-3 py-1 text-xs font-medium text-stone-100 hover:bg-stone-700 disabled:opacity-60"
					title="Fetch this change anyway in the next update: only after looking at the source"
				>
					{accepting ? 'Accepting…' : l.plan.polled ? 'Accept: fetch it anyway' : `Accept ${shortCommit(l.plan.to.id)}`}
				</button>
			</form>
		</div>
	{/if}
{/snippet}

{#snippet gateCell(l: Lane)}
	{@render node(l.gate, 'Gate', hue(l.site))}
	{#if l.authors}
		<div class="mt-1.5 rounded-md border border-dashed border-stone-800 px-2 py-1 text-xs">
			<span class="text-stone-500">Authors · factorioprints only:</span>
			<span class={l.authors.state === 'bad' ? 'text-rose-300' : l.authors.state === 'warn' ? 'text-amber-200' : 'text-stone-400'}>
				{l.authors.state === 'active' ? 'naming…' : l.authors.text || '—'}
			</span>
		</div>
	{/if}
{/snippet}

{#snippet shotsBody()}
	<div class="node {flow.shots.stage.state} h-full" style="--c: #f59e0b">
		<p class="flex items-center gap-1.5 text-[0.68rem] font-semibold tracking-wide text-stone-500 uppercase">
			{#if flow.shots.stage.state === 'active'}<span class="spinner" aria-hidden="true"></span>{:else if ICON[flow.shots.stage.state]}<span class="mark {flow.shots.stage.state}">{ICON[flow.shots.stage.state]}</span>{/if}
			Screenshots <span class="font-normal tracking-normal normal-case">· 3 inputs, one shared sizing</span>
		</p>
		{#if flow.shots.stage.text}<p class="mt-0.5 text-xs text-stone-400">{flow.shots.stage.text}</p>{/if}
		<div class="mt-1.5 space-y-1.5">
			{#each flow.shots.inputs as input (input.key)}
				<div class="rounded-md border border-stone-800 px-2 py-1.5 {input.stage.state === 'active' ? 'live-input' : ''}">
					<p class="flex flex-wrap items-center gap-x-1.5 text-xs">
						{#each input.sites as s (s)}<span class="inline-block size-2 rounded-full" style="background: {hue(s)}" title={s}></span>{/each}
						<span class="font-medium text-stone-300">{input.label}</span>
						<span class="text-stone-500">← {input.sites.join(', ')}</span>
					</p>
					{#if input.stage.of}
						<p class="text-sm text-stone-100 tabular-nums">{int(input.stage.value ?? 0)} <small class="text-xs text-stone-500">/ {int(input.stage.of)}</small></p>
						{@render bar(input.stage.value ?? 0, input.stage.of, '#f59e0b')}
					{/if}
					{#if input.live?.length}
						<p class="mt-0.5 flex flex-wrap gap-x-2.5 text-xs text-stone-400">
							{#each input.live as s (s.site)}<span>{s.site} <b class="text-stone-200 tabular-nums">{int(s.fetched)}</b>{#if s.failed} · <b class="text-amber-200 tabular-nums">{int(s.failed)}</b> failed{/if}</span>{/each}
						</p>
					{/if}
					{#if input.stage.figs?.length}
						<p class="mt-0.5 flex flex-wrap gap-x-2.5 text-xs text-stone-500">
							{#each input.stage.figs as f, i (i)}<span>{f.label} <b class="font-semibold tabular-nums {f.tone === 'bad' ? 'text-rose-300' : f.tone === 'warn' ? 'text-amber-200' : 'text-stone-300'}">{typeof f.value === 'number' ? int(f.value) : f.value}</b></span>{/each}
						</p>
					{:else if input.stage.state === 'todo' || input.stage.state === 'skip'}
						<p class="text-xs text-stone-600">{input.stage.state === 'skip' ? 'not run' : '—'}</p>
					{/if}
				</div>
			{/each}
			<div class="rounded-md border border-amber-500/20 bg-amber-500/[0.04] px-2 py-1.5">
				<p class="text-xs font-medium text-stone-300">Sizing and upload <span class="font-normal text-stone-500">· shared</span></p>
				{#if flow.shots.sizing.figs?.length}
					<p class="mt-0.5 flex flex-wrap gap-x-2.5 text-xs text-stone-500">
						{#each flow.shots.sizing.figs as f, i (i)}<span>{f.label} <b class="font-semibold tabular-nums {f.tone === 'bad' ? 'text-rose-300' : 'text-stone-300'}">{typeof f.value === 'number' ? int(f.value) : f.value}</b></span>{/each}
					</p>
				{:else}
					<p class="text-xs text-stone-600">{flow.shots.sizing.state === 'skip' ? 'not run' : '—'}</p>
				{/if}
			</div>
		</div>
	</div>
{/snippet}

{#snippet renderBody()}
	<div class="h-full">
		{@render node(flow.render, 'Render · shared', '#f59e0b', 'One render run for every source: it reads the mirror clone and the record store')}
		<p class="mt-1.5 text-[0.68rem] text-stone-500">One run for every source, reading the mirror clone and the record store.</p>
	</div>
{/snippet}

{#snippet sink()}
	<div class="flex flex-wrap items-baseline gap-x-6 gap-y-1 rounded-lg border border-stone-800 bg-gradient-to-r from-amber-500/[0.06] to-transparent px-4 py-2.5 text-sm">
		<span class="text-xs font-semibold tracking-wide text-stone-500 uppercase">→ The site{figures ? ` · ${figures.stage}` : ''}</span>
		{#if figures}
			<span><b class="text-lg font-semibold text-stone-100 tabular-nums">{int(figures.prints)}</b> <span class="text-stone-400">prints</span></span>
			<span><b class="text-lg font-semibold text-stone-100 tabular-nums">{int(figures.rendered)}</b> <span class="text-stone-400">with a render</span></span>
			<span class="text-xs text-stone-500">as counted {when(figures.at, now, timeZone)}</span>
		{:else}
			<span class="text-stone-500">not counted yet</span>
		{/if}
		{#if flow.newPrints}<span class="text-emerald-300 tabular-nums">+{int(flow.newPrints)} new prints {flow.live ? 'so far in this update' : 'in the last update'}</span>{/if}
	</div>
{/snippet}

<section aria-labelledby="flow-title" class="space-y-2">
	<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
		<h2 id="flow-title" class="text-xs font-semibold tracking-wide text-stone-500 uppercase">Where the prints go</h2>
		{#if flow.caption}<p class="text-xs text-stone-500">Read, Gate, Screenshots and Render: <span class="text-stone-300">{flow.caption}</span></p>{/if}
	</div>

	<!-- Wide screens: the lanes side by side, the shared stages spanning them. -->
	<div class="board hidden lg:grid">
		<div class="head" style="grid-column: 1">Source</div>
		<div class="head" style="grid-column: 2">Waiting <span>now</span></div>
		<div class="head" style="grid-column: 4">Read <span>per source</span></div>
		<div class="head" style="grid-column: 6">Gate <span>one gate · every record ends in applyPlan</span></div>
		<div class="head" style="grid-column: 8">Screenshots <span>shared</span></div>
		<div class="head" style="grid-column: 10">Render <span>shared</span></div>
		{#each flow.lanes as l, i (l.site)}
			{@const row = i + 2}
			<div class="lane-bg {l.plan?.blocked ? 'held' : ''}" style="grid-row: {row}; --c: {hue(l.site)}"></div>
			<div class="cell" style="grid-row: {row}; grid-column: 1">{@render who(l, true)}</div>
			<div class="cell" style="grid-row: {row}; grid-column: 2">{@render node(l.waiting, 'Waiting', hue(l.site), position(l))}{#if position(l)}<p class="mt-0.5 truncate font-mono text-[0.65rem] text-stone-600" title={position(l)}>{position(l)}</p>{/if}</div>
			{#if l.plan?.blocked && !flow.live}
				<!-- Held back: nothing goes further until it is accepted; the reason and Accept take the lane. -->
				<div class="cell" style="grid-row: {row}; grid-column: 3 / 8">{@render held(l)}</div>
			{:else}
				<div class="cell pipe-cell" style="grid-row: {row}; grid-column: 3">{@render pipe(l.read, hue(l.site))}</div>
				<div class="cell" style="grid-row: {row}; grid-column: 4">{@render node(l.read, 'Read', hue(l.site))}</div>
				<div class="cell pipe-cell" style="grid-row: {row}; grid-column: 5">{@render pipe(l.gate, hue(l.site))}</div>
				<div class="cell" style="grid-row: {row}; grid-column: 6">{@render gateCell(l)}</div>
				<div class="cell pipe-cell" style="grid-row: {row}; grid-column: 7">{@render pipe(flow.shots.stage, hue(l.site))}</div>
			{/if}
		{/each}
		<div class="cell" style="grid-row: 2 / span {flow.lanes.length}; grid-column: 8">{@render shotsBody()}</div>
		<div class="cell pipe-cell" style="grid-row: 2 / span {flow.lanes.length}; grid-column: 9">{@render pipe(flow.render, '#f59e0b')}</div>
		<div class="cell" style="grid-row: 2 / span {flow.lanes.length}; grid-column: 10">{@render renderBody()}</div>
	</div>

	<!-- Phones and narrow screens: one card per source (only the stages its prints reached), then the shared stages. -->
	<div class="space-y-2 lg:hidden">
		{#each flow.lanes as l (l.site)}
			<article class="rounded-lg border border-l-[3px] bg-stone-900/50 p-3 {l.plan?.blocked ? 'border-rose-900 bg-rose-950/20' : 'border-stone-800'}" style="border-left-color: {hue(l.site)}">
				{@render who(l, false)}
				<div class="mt-2">{@render held(l)}</div>
				<div class="mt-2 space-y-1.5">
					{@render node(l.waiting, 'Waiting', hue(l.site), position(l))}
					{#if reached(l.read) || l.read.state === 'held'}{@render pipe(l.read, hue(l.site))}{@render node(l.read, 'Read', hue(l.site))}{/if}
					{#if reached(l.gate)}{@render pipe(l.gate, hue(l.site))}{@render gateCell(l)}{:else if l.authors && reached(l.authors)}{@render gateCell(l)}{/if}
				</div>
			</article>
		{/each}
		<p class="pt-1 text-xs font-semibold tracking-wide text-stone-500 uppercase">Shared by every source</p>
		{@render shotsBody()}
		{@render renderBody()}
	</div>

	{#if sitesShots?.stage.figs?.length && !flow.live}
		<p class="text-[0.68rem] text-stone-600">Other sites’ screenshots and renders aren’t counted per site by the update; they show once, for every source.</p>
	{/if}
	{@render sink()}
</section>

<style>
	.board {
		grid-template-columns: 11rem minmax(0, 1fr) 1.25rem minmax(0, 1fr) 1.25rem minmax(0, 1.35fr) 1.25rem minmax(0, 1.45fr) 1.25rem minmax(0, 1.1fr);
		column-gap: 0;
		row-gap: 0.5rem;
		position: relative;
	}
	.head {
		grid-row: 1;
		padding: 0 0.25rem 0.1rem;
		font-size: 0.68rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: #78716c;
	}
	.head span {
		display: block;
		font-weight: 400;
		letter-spacing: 0;
		text-transform: none;
		color: #57534e;
	}
	.lane-bg {
		grid-column: 1 / 8;
		border: 1px solid #292524;
		border-left: 3px solid var(--c);
		border-radius: 0.6rem;
		background: color-mix(in srgb, #1c1917 50%, transparent);
	}
	.lane-bg.held {
		border-color: #881337;
		border-left-color: #fb7185;
		background: color-mix(in srgb, #4c0519 35%, transparent);
	}
	.cell {
		position: relative;
		padding: 0.55rem 0.4rem;
		min-width: 0;
	}
	.cell:first-of-type {
		padding-left: 0.7rem;
	}
	.pipe-cell {
		display: flex;
		align-items: center;
		padding: 0;
	}
	.node {
		border: 1px solid #292524;
		border-radius: 0.5rem;
		background: #0c0a09;
		padding: 0.4rem 0.55rem;
		min-width: 0;
		transition:
			box-shadow 0.3s,
			border-color 0.3s;
	}
	.node.todo {
		border-style: dashed;
		opacity: 0.55;
	}
	.node.skip,
	.node.off {
		opacity: 0.6;
	}
	.node.warn {
		border-color: color-mix(in srgb, #b45309 70%, transparent);
	}
	.node.bad,
	.node.held {
		border-color: #9f1239;
	}
	.node.active {
		border-color: var(--c);
		box-shadow:
			0 0 0 1px var(--c),
			0 0 22px -6px var(--c);
		animation: glow 2s ease-in-out infinite;
	}
	.mark {
		font-weight: 700;
	}
	.mark.done {
		color: #34d399;
	}
	.mark.warn {
		color: #fcd34d;
	}
	.mark.bad,
	.mark.held {
		color: #fb7185;
	}
	.spinner {
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 999px;
		border: 2px solid color-mix(in srgb, #f59e0b 30%, transparent);
		border-top-color: #fbbf24;
		animation: spin 0.9s linear infinite;
	}
	.pipe {
		position: relative;
		width: 100%;
		height: 2px;
		background: #44403c;
	}
	.pipe.filled {
		background: color-mix(in srgb, var(--c) 60%, transparent);
	}
	.pipe.flowing span {
		position: absolute;
		inset: -3px 0;
		background: radial-gradient(circle, var(--c) 0 2.5px, transparent 3px) 0 50% / 10px 8px repeat-x;
		animation: travel 0.6s linear infinite;
	}
	.live-input {
		border-color: color-mix(in srgb, #f59e0b 60%, transparent);
		box-shadow: 0 0 16px -8px #f59e0b;
	}
	@media (max-width: 1023px) {
		.pipe {
			width: 2px;
			height: 0.8rem;
			margin-left: 1rem;
		}
		.pipe.flowing span {
			inset: 0 -3px;
			background: radial-gradient(circle, var(--c) 0 2.5px, transparent 3px) 50% 0 / 8px 10px repeat-y;
			animation-name: travel-down;
		}
	}
	@keyframes travel {
		to {
			background-position: 10px 50%;
		}
	}
	@keyframes travel-down {
		to {
			background-position: 50% 10px;
		}
	}
	@keyframes glow {
		50% {
			box-shadow:
				0 0 0 1px var(--c),
				0 0 30px -4px var(--c);
		}
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	/* Reduced motion: a still board, no travelling dots or glow. */
	@media (prefers-reduced-motion: reduce) {
		.node.active,
		.spinner {
			animation: none;
		}
		.pipe.flowing span {
			display: none;
		}
		.pipe.flowing {
			background: var(--c);
		}
	}
</style>
