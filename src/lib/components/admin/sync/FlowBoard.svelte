<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SyncFigures, SyncSettings } from '#lib/sync.js';
	import { int, when } from '../metrics.js';
	import { CELL_LINES, COLUMNS, type Cell, type ColumnId, type Flow, type Row } from './flow.js';
	import Toggle from './Toggle.svelte';
	import { shortCommit } from './view.js';

	/**
	 * The Update tab's board (flow.ts): source rows × the update's steps in order, Changes | Added | Authors |
	 * Screenshots, then the render run's stages Plan | Draw | Upload | Thumbnails under one "Render" group, and a
	 * Shared row for what is done once. Every cell is a status icon over room for exactly CELL_LINES lines (one fact
	 * per line, flow.ts fitCell), so no cell changes size as its lines come and go; each row has one straight line
	 * through its cells, coloured as far as its prints have got. Every step column is the same width and every row
	 * the same height; on narrow screens the board scrolls sideways inside itself. The polled sites'
	 * switches sit on their rows before an update (bound settings, saved by the page on `onchange`); a held-back
	 * source gets Accept in its Changes cell.
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

	const HUE: Record<string, string> = {
		factorioprints: '#f59e0b',
		codex: '#38bdf8',
		fprints: '#a78bfa',
		uploads: '#34d399',
		factoriobin: '#f472b6'
	};
	const hue = (site: string) => HUE[site] ?? '#a8a29e';
	const HEADS: Record<ColumnId, { name: string; sub: string; tip?: string }> = {
		changes: { name: 'Changes', sub: 'at the source', tip: 'Step 2: what each source has that this machine hasn’t, read one source after another' },
		added: { name: 'Added', sub: 'one source at a time' },
		authors: { name: 'Authors', sub: 'factorioprints only', tip: 'Step 4: only factorioprints records arrive without names' },
		shots: { name: 'Screenshots', sub: 'copied, then sized once', tip: 'Step 5: each source’s images copied, then sized and uploaded together' },
		plan: { name: 'Plan', sub: 'batch and pages' },
		draw: { name: 'Draw', sub: 'pages' },
		upload: { name: 'Upload', sub: 'to the renders bucket' },
		thumbs: { name: 'Thumbnails', sub: 'per print' }
	};
	const GATE_TIP =
		'Step 3: every record from every source goes through one gate (blocked or unreadable refused; a blueprint already on the site is matched), one source at a time: factorioprints through the backfill, then codex, then fprints; uploads are admitted in the fetch.';
	const RENDER_TIP = 'Step 6: one render run for every source, under one limit. Stages overlap: each print moves on as soon as it’s drawn.';
	/** Each row's height: the cell's padding, borders, its icon and CELL_LINES lines of 1rem (see `.c7`). */
	const ROW_H = `calc(${CELL_LINES}rem + 2.95rem)`;
	const KIND_WORD: Record<Cell['kind'], string> = {
		done: 'done',
		run: 'running',
		found: 'found, waiting to run',
		part: 'part-way',
		warn: 'done, look at it',
		bad: 'couldn’t run',
		wait: 'not run yet',
		na: 'doesn’t apply'
	};
	const MARK: Partial<Record<Cell['kind'], string>> = { done: '✓', warn: '!', bad: '✕', na: '—' };
	/** Grid columns: the source names, then the eight step columns, all one width. */
	const COL = (c: ColumnId) => COLUMNS.indexOf(c) + 2;
	/** Grid rows: the Render group's header, the column heads, then the sources and the Shared row. */
	const R1 = 3;
	const shared = $derived(R1 + flow.rows.length);
	const shotsReached = $derived(flow.rows.some((r) => r.reach >= COLUMNS.indexOf('shots')));
	/** The sources whose Accept is being sent, by name. */
	let accepting = $state<Record<string, boolean>>({});
</script>

{#snippet accept(r: Row)}
	{#if r.held}
		<form
			method="POST"
			action="?/accept"
			class="mt-1"
			use:enhance={() => {
				const site = r.held!.site;
				accepting[site] = true;
				return async ({ result, update }) => {
					await update({ reset: false });
					accepting[site] = false;
					if (result.type === 'success') onaccepted();
				};
			}}
		>
			<input type="hidden" name="site" value={r.held.site} />
			<input type="hidden" name="id" value={r.held.id} />
			<button
				disabled={accepting[r.held.site]}
				class="rounded border border-stone-700 bg-stone-800 px-2 py-0.5 text-[0.7rem] font-medium text-stone-100 hover:bg-stone-700 disabled:opacity-60"
				title="Fetch this change anyway in the next update: only after looking at the source"
			>
				{accepting[r.held.site] ? 'Accepting…' : r.held.polled ? 'Accept' : `Accept ${shortCommit(r.held.id)}`}
			</button>
		</form>
	{/if}
{/snippet}

{#snippet box(c: Cell, held: Row | null = null)}
	<div class="c7 {c.kind}" title={c.tip}>
		<span class="sr-only">{c.label ? `${c.label}: ` : ''}{KIND_WORD[c.kind]}.</span>
		<span class="mark" aria-hidden="true">
			{#if c.kind === 'run'}<span class="spin"></span>{:else}<span class="ic {c.kind}">{MARK[c.kind] ?? ''}</span>{/if}
		</span>
		<span class="lines">
			{#if c.label}<span class="lab line">{c.label}</span>{/if}
			{#each c.facts as f, i (i)}
				<span class="fact line {f.tone ?? ''}">{#if f.n !== undefined}<b>{typeof f.n === 'number' ? int(f.n) : f.n}</b>{f.text ? ' ' : ''}{/if}{f.text}</span>
			{/each}
			{#if held}{@render accept(held)}{/if}
		</span>
		{#if c.bar !== undefined && c.bar !== null}<i class="wbar" aria-hidden="true"><span style="width: {c.bar}%"></span></i>{/if}
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
		<p class="text-xs text-stone-500"><span class="text-stone-300">{flow.caption.lead}</span> {flow.caption.rest}</p>
	</div>

	<div class="scroller">
		<div class="board" style="grid-template-rows: auto auto repeat({flow.rows.length + 1}, {ROW_H})">
			<!-- The Render group's header, over its four stages. -->
			<div class="head grp" style="grid-row: 1; grid-column: {COL('plan')} / span 4" title={RENDER_TIP}>
				Render
				<span class="sub">stages overlap: each print moves on as soon as it’s drawn</span>
			</div>
			<div class="head first" style="grid-row: 2; grid-column: 1">Source</div>
			{#each COLUMNS as c (c)}
				{@const h = HEADS[c]}
				<div class="head" style="grid-row: 2; grid-column: {COL(c)}" title={c === 'added' ? GATE_TIP : (h.tip ?? RENDER_TIP)}>
					{h.name}{#if c === 'added'}<span class="gate-n">&nbsp;· one gate</span>{/if}
					<span class="sub">{c === 'draw' && flow.threads ? `pages, ${int(flow.threads)} threads` : h.sub}</span>
				</div>
			{/each}

			{#each flow.rows as r, i (r.site)}
				{@const row = R1 + i}
				<div class="lane" style="grid-row: {row}; --c: {hue(r.site)}"></div>
				<!-- One straight line through the row's cells: its colour as far as its prints have got, grey after. -->
				{#if r.reach >= 0}
					<div class="wire" style="grid-row: {row}; grid-column: {COL('changes')} / {r.reach + 3}; --c: {hue(r.site)}"></div>
				{/if}
				{#if r.reach < COLUMNS.length - 1}
					<div class="wire grey" style="grid-row: {row}; grid-column: {Math.max(COL('changes'), r.reach + 2)} / {COLUMNS.length + 2}"></div>
				{/if}
				<div class="cell first" style="grid-row: {row}; grid-column: 1">
					<div class="who">
						{#if r.toggle}
							<Toggle bind:checked={settings.polled[r.toggle].on} id="polled-{r.toggle}-on" label="Fetch prints from {r.site}" {onchange} />
						{/if}
						<p class="name" title={r.tip}>{r.site}</p>
					</div>
				</div>
				{#each COLUMNS as c (c)}
					<div class="cell" style="grid-row: {row}; grid-column: {COL(c)}">{@render box(r.cells[c], c === 'changes' ? r : null)}</div>
				{/each}
			{/each}

			<!-- The Shared row: what is done once for every source. -->
			<div class="vwire {shotsReached ? '' : 'grey'}" style="grid-row: {R1} / {shared}; grid-column: {COL('shots')}"></div>
			<div class="lane shared-lane" style="grid-row: {shared}; --c: #57534e"></div>
			<div class="cell first" style="grid-row: {shared}; grid-column: 1">
				<div>
					<p class="name">Shared</p>
					<p class="text-[0.7rem] leading-tight text-stone-500">done once for every source</p>
				</div>
			</div>
			<div class="cell" style="grid-row: {shared}; grid-column: {COL('shots')}">{@render box(flow.shared.sizing)}</div>
			<div class="cell" style="grid-row: {shared}; grid-column: {COL('plan')} / span 2">
				<div class="c7 sum" title={[flow.shared.summary.title, ...flow.shared.summary.lines].join('\n')}>
					<span class="lines">
						<span class="lab line">{flow.shared.summary.title}</span>
						{#each flow.shared.summary.lines as line, i (i)}<span class="fact line text-stone-400">{line}</span>{/each}
					</span>
				</div>
			</div>
			<div class="cell" style="grid-row: {shared}; grid-column: {COL('upload')}">{@render box(flow.shared.cleanup)}</div>
			<div class="cell" style="grid-row: {shared}; grid-column: {COL('thumbs')}">{@render box(flow.shared.flags)}</div>

			<!-- Outlines: the one gate, and the render run's group. -->
			<div class="outline-box" style="grid-row: 2 / span {flow.rows.length + 1}; grid-column: {COL('added')}"></div>
			<div class="outline-box grp" style="grid-row: 1 / span {flow.rows.length + 3}; grid-column: {COL('plan')} / span 4"></div>
		</div>
	</div>
	{@render sink()}
</section>

<style>
	.scroller {
		/* The board's own sideways scroll on narrow screens; the page never scrolls sideways. */
		overflow-x: auto;
		max-width: 100%;
		padding-bottom: 2px;
	}
	.board {
		display: grid;
		grid-template-columns: 9.5rem repeat(8, minmax(0, 1fr));
		row-gap: 0.5rem;
		min-width: 72rem;
		position: relative;
	}
	.head {
		position: relative;
		z-index: 3;
		padding: 0 0.4rem 0.25rem;
		font-size: 0.68rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: #a8a29e;
		cursor: help;
	}
	.head.first {
		color: #78716c;
		padding-left: 0.75rem;
		cursor: default;
	}
	.head .sub {
		display: block;
		font-weight: 400;
		letter-spacing: 0;
		text-transform: none;
		color: #78716c;
	}
	.head .gate-n {
		font-weight: 400;
		letter-spacing: 0;
		text-transform: none;
		color: #a8a29e;
	}
	.head.grp {
		padding: 0.4rem 0.6rem 0.15rem;
		color: #d6d3d1;
	}
	.lane {
		grid-column: 1 / -1;
		border: 1px solid #292524;
		border-left: 3px solid var(--c);
		border-radius: 0.6rem;
		background: color-mix(in srgb, #1c1917 50%, transparent);
	}
	.shared-lane {
		background: color-mix(in srgb, #1c1917 30%, transparent);
	}
	.wire {
		position: relative;
		z-index: 1;
		align-self: center;
		height: 2px;
		margin: 0 3rem;
		background: color-mix(in srgb, var(--c) 70%, transparent);
		pointer-events: none;
	}
	.wire.grey {
		background: #44403c;
	}
	.vwire {
		position: relative;
		z-index: 1;
		justify-self: center;
		width: 2px;
		margin: 2.75rem 0 -1rem;
		background: #f59e0b55;
		pointer-events: none;
	}
	.vwire.grey {
		background: repeating-linear-gradient(#44403c 0 4px, transparent 4px 8px);
	}
	.cell {
		position: relative;
		z-index: 2;
		display: flex;
		align-items: stretch;
		padding: 0.3rem;
		min-width: 0;
	}
	.cell.first {
		position: sticky;
		left: 0;
		z-index: 4;
		align-items: center;
		/* Inside the lane's borders, so a background on narrow screens doesn't hide them. */
		margin: 1px 0 1px 3px;
		padding-left: calc(0.75rem - 3px);
	}
	.who {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.name {
		color: #f5f5f4;
		font-size: 0.95rem;
		white-space: nowrap;
	}
	.name[title] {
		cursor: help;
	}
	/*
	 * One size for every cell: the status icon's row (1.4rem), then exactly CELL_LINES lines of 1rem, whether
	 * they're filled or not; the progress bar sits in the bottom padding. Lines never wrap: a long one is cut
	 * with an ellipsis, and the tooltip has the whole story. ROW_H: these plus ≈ 1.5rem of padding and borders.
	 */
	.c7 {
		position: relative;
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		border: 1px solid #292524;
		border-radius: 0.5rem;
		background: #0c0a09;
		padding: 0.25rem 0.5rem 0.5rem;
		font-size: 0.75rem;
		line-height: 1rem;
		color: #d6d3d1;
		min-width: 0;
		overflow: hidden;
		cursor: help;
	}
	.c7 .mark {
		display: flex;
		align-items: center;
		height: 1.4rem;
		flex: none;
	}
	.c7 .lines {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		width: 100%;
		min-width: 0;
		flex: none;
	}
	.c7 .line {
		display: block;
		max-width: 100%;
		height: 1rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.c7 .fact b {
		color: #f5f5f4;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.c7 .fact.warn,
	.c7 .fact.warn b {
		color: #fcd34d;
	}
	.c7 .fact.bad,
	.c7 .fact.bad b {
		color: #fda4af;
	}
	.c7 .lab {
		color: #d6d3d1;
		font-weight: 500;
	}
	.c7.found,
	.c7.warn {
		border-color: #b4530999;
	}
	.c7.run {
		border-color: #f59e0b99;
		box-shadow: 0 0 16px -8px #f59e0b;
	}
	.c7.bad {
		border-color: #9f1239;
	}
	.c7.wait,
	.c7.na {
		border-style: dashed;
		border-color: #44403c;
	}
	.c7.wait .lab {
		color: #78716c;
	}
	.c7.sum {
		cursor: default;
		padding-top: 0.45rem;
	}
	.ic {
		display: inline-grid;
		place-items: center;
		width: 1.35rem;
		height: 1.35rem;
		font-size: 1.15rem;
		font-weight: 700;
		line-height: 1;
	}
	.ic.done {
		color: #34d399;
	}
	.ic.warn {
		color: #fcd34d;
	}
	.ic.bad {
		color: #fb7185;
	}
	.ic.na {
		color: #78716c;
		font-weight: 400;
	}
	.ic.found::before {
		content: '';
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 50%;
		background: #f59e0b;
	}
	.ic.wait::before {
		content: '';
		width: 0.75rem;
		height: 0.75rem;
		border-radius: 50%;
		border: 2px solid #57534e;
	}
	.ic.part::before {
		content: '';
		width: 0.95rem;
		height: 0.95rem;
		border-radius: 50%;
		background: conic-gradient(#f59e0b 0 65%, #44403c 65% 100%);
	}
	.spin {
		display: inline-block;
		width: 1rem;
		height: 1rem;
		margin: 0 0.175rem;
		border-radius: 999px;
		border: 2px solid color-mix(in srgb, #f59e0b 30%, transparent);
		border-top-color: #fbbf24;
		animation: spin 0.9s linear infinite;
	}
	.wbar {
		position: absolute;
		left: 0.5rem;
		right: 0.5rem;
		bottom: 0.2rem;
		display: block;
		height: 3px;
		border-radius: 99px;
		background: #292524;
		overflow: hidden;
	}
	.wbar span {
		display: block;
		height: 100%;
		background: #f59e0b;
		transition: width 0.5s;
	}
	/* Not `.ring`: Tailwind has a utility of that name. */
	.outline-box {
		position: relative;
		z-index: 2;
		pointer-events: none;
		margin: -0.25rem 0 0;
		border: 1px solid #a8a29e55;
		border-radius: 0.65rem;
	}
	.outline-box.grp {
		border-color: #f59e0b55;
		margin: 0 1px;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	/* Reduced motion: a still ring with a lit quarter. */
	@media (prefers-reduced-motion: reduce) {
		.spin {
			animation: none;
		}
	}
	/* Narrow screens: the sources' names stay in view while the board scrolls under them. */
	@media (max-width: 1279px) {
		.cell.first {
			background: linear-gradient(to right, #161412 80%, transparent);
		}
	}
</style>
