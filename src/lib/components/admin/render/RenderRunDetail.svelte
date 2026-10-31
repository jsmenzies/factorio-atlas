<script lang="ts">
	import { parseStages, stageTotals } from '#lib/render-stages.js';
	import type { RenderRun } from '#lib/server/admin/render.js';
	import { bytes, clock, duration, elapsed, eta, int, isLiveState, percent, shownState } from '../metrics.js';
	import OutcomeList from '../OutcomeList.svelte';
	import ReasonBars from '../ReasonBars.svelte';
	import RunAlerts from '../RunAlerts.svelte';
	import RunControls from '../RunControls.svelte';
	import RunHeader from '../RunHeader.svelte';
	import {
		byteRate,
		fileRate,
		pageRate,
		perMinute,
		printProgress,
		RENDER_OUTCOMES,
		RENDER_STOP_NOTE,
		renderOptionChips,
		storageProjection,
		uploadProgress,
		uploadSpeed,
		writtenAverages
	} from './metrics.js';
	import RenderOutcomeBar from './RenderOutcomeBar.svelte';

	let {
		run,
		skipReasons,
		now,
		staleMs,
		heartbeatMs,
		message,
		timeZone,
		href,
		controls = true
	}: {
		run: RenderRun;
		/** This run's skipped pages by kind of reason. */
		skipReasons: [string, number][];
		now: number;
		staleMs: number;
		heartbeatMs: number;
		message?: string;
		timeZone?: string;
		/** Link from the heading to the run's own page. */
		href?: string;
		/** Pause / resume / stop here (off where the start panel shows them). */
		controls?: boolean;
	} = $props();

	const runState = $derived(shownState(run, now, staleMs));
	const live = $derived(isLiveState(runState));
	const ended = $derived(!live && runState !== 'crashed');
	const left = $derived(Math.max(0, run.total - run.done));
	const pct = $derived(run.total > 0 ? Math.min(100, (run.done / run.total) * 100) : 0);
	const rate = $derived(pageRate(run.rate));
	const finish = $derived(live && runState !== 'paused' ? eta(run, now) : null);
	const proj = $derived(storageProjection(run));
	const chips = $derived(renderOptionChips(run.options));
	const up = $derived(uploadProgress(run));
	const took = $derived(elapsed(run, runState, now));
	const prints = $derived(printProgress(run));
	// After the last page (options written by the heartbeat): what the run does before it ends, and its thumbnails.
	const phase = $derived(run.options.phase ?? null);
	const thumbs = $derived.by(() => {
		const stages = parseStages(run.options.stages);
		const t = stages ? stageTotals(stages) : null;
		return t?.thumbsOf ? { done: t.thumbsDone, of: t.thumbsOf } : null;
	});
	const PHASE = {
		thumbnails: 'Every page drawn; making thumbnails',
		uploads: 'Uploading the last pages',
		deletions: 'Removing replaced files',
		flags: 'Setting the search flags'
	} as const;
	const avg = $derived(writtenAverages(run));
	const speed = $derived(uploadSpeed(run, took, live && runState !== 'paused'));
	const PACE = {
		idle: { text: 'Uploads are up to date', tone: 'text-emerald-300' },
		'keeping-up': { text: 'Uploads are keeping up with rendering', tone: 'text-emerald-300' },
		behind: { text: 'Uploads are falling behind: rendering is faster, so the backlog grows', tone: 'text-amber-300' },
		stalled: { text: 'Pages are waiting but none went up in the last 5 minutes', tone: 'text-amber-300' },
		draining: { text: 'Rendering is done; uploading what is left', tone: 'text-sky-300' }
	} as const;

	const card = 'rounded-lg border border-stone-800 bg-stone-900/50 p-4';
	const label = 'text-xs font-medium tracking-wide text-stone-500 uppercase';
</script>

<article class="space-y-5">
	<RunHeader {run} {runState} {chips} {now} {timeZone}>
		{#snippet heading()}
			<h2 class="text-xl font-semibold text-stone-100">
				{#if href}<a {href} class="hover:text-amber-300">Render run</a>{:else}Render run{/if}
			</h2>
		{/snippet}
	</RunHeader>

	<RunAlerts {run} {runState} who="Renderer" {now} {timeZone}>
		{#snippet advice()}
			It may have crashed or the machine may be asleep. If it comes back it carries on (and acts on any request below). Otherwise run
			<code>bun run render --resume</code>: pages left mid-render go back in the queue, rendered ones are never drawn again, and pages
			that were going up are uploaded again.
		{/snippet}
	</RunAlerts>

	{#if controls}<RunControls {run} {heartbeatMs} {message} who="renderer" stopNote={RENDER_STOP_NOTE} />{/if}

	<!-- Progress and outcomes -->
	<section class="{card} space-y-4" aria-label="Progress">
		<div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
			<p class="text-stone-300">
				<span class="text-3xl font-semibold text-stone-100 tabular-nums">{run.total > 0 ? `${Math.floor(pct)}%` : '–'}</span>
				<span class="ml-2 tabular-nums">{int(run.done)} of {int(run.total)} pages</span>
				{#if left > 0}<span class="text-stone-500"> · {int(left)} {ended ? 'not processed' : 'left'}</span>{/if}
				{#if prints}
					<span class="block text-sm text-stone-400 tabular-nums" title="A print is finished once every page of it is rendered, unchanged, skipped or failed">
						<span class="text-stone-100">{int(prints.done)}</span> of {int(prints.total)} prints finished{#if prints.picking}<span class="text-stone-500">{` · picking${prints.goal ? `, up to ${int(prints.goal)}` : ''}`}</span>{:else if prints.pct !== null && prints.total > 0}<span class="text-stone-500">{` · ${Math.floor(prints.pct)}%`}</span>{/if}
					</span>
				{/if}
				{#if thumbs}
					<span class="block text-sm tabular-nums {live && phase ? 'text-sky-300' : 'text-stone-400'}">
						{live && phase ? `${PHASE[phase]} · ` : ''}thumbnails: <span class="text-stone-100">{int(thumbs.done)}</span> of {int(thumbs.of)} prints
					</span>
				{:else if live && phase}
					<span class="block text-sm text-sky-300">{PHASE[phase]}</span>
				{/if}
			</p>
			{#if finish && finish.left > 0}
				<p class="text-sm text-stone-300">
					<span class="text-stone-500">ETA</span>
					{duration(finish.left)} <span class="text-stone-500">· around {clock(finish.at, now, timeZone)}</span>
				</p>
			{:else if runState === 'paused'}
				<p class="text-sm text-amber-300">Paused</p>
			{/if}
		</div>
		<RenderOutcomeBar {run} />
		<OutcomeList {run} outcomes={RENDER_OUTCOMES} columns="lg:grid-cols-4" />
	</section>

	{#if up}
		<!-- Uploads into a RENDERS bucket, as pages finish -->
		<section class="{card} space-y-3" aria-label="Upload">
			<div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
				<p class="text-stone-300">
					<span class="text-2xl font-semibold text-stone-100 tabular-nums">{up.pct === null ? '–' : `${Math.floor(up.pct)}%`}</span>
					<span class="ml-2">uploaded to <span class="font-medium text-stone-100">{run.upload_target}</span>:</span>
					<span class="tabular-nums">{int(run.uploaded)} of {int(up.whole)} pages</span>
					{#if run.uploads_pending > 0}<span class="text-stone-500"> · {int(run.uploads_pending)} {ended ? 'not uploaded' : 'waiting'}</span>{/if}
				</p>
				<p class="text-sm text-stone-400 tabular-nums">
					{int(run.upload_files)} files · {bytes(run.upload_bytes)}{#if run.upload_deleted > 0}<span> · {int(run.upload_deleted)} deleted</span>{/if}
					{#if run.upload_deletes_pending > 0}<span title="Replaced files wait out a grace period before they are deleted from the bucket"
							>· {int(run.upload_deletes_pending)} deletions pending</span
						>{/if}
				</p>
			</div>
			<div
				class="flex h-2 w-full overflow-hidden rounded-full bg-stone-800"
				role="img"
				aria-label="{int(run.uploaded)} of {int(up.whole)} rendered pages uploaded"
			>
				<div class="h-full bg-sky-500 transition-[width] duration-700" style="width: {up.pct ?? 0}%"></div>
			</div>
			{#if speed}
				<dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm lg:grid-cols-4">
					<div>
						<dt class="text-xs text-stone-500">{ended ? 'Speed' : 'Now'} <span class="text-stone-600">· last minute</span></dt>
						<dd class="text-stone-100 tabular-nums">
							{#if ended || runState === 'crashed'}–{:else if !speed.measured}<span class="text-stone-500">not measured by this runner</span
								>{:else}{byteRate(speed.bytesPerSec)}
								<span class="text-stone-400">· {fileRate(speed.filesPerSec)}</span>{/if}
						</dd>
					</div>
					<div>
						<dt class="text-xs text-stone-500">Average <span class="text-stone-600">· over the run</span></dt>
						<dd class="text-stone-100 tabular-nums">
							{byteRate(speed.avgBytesPerSec)} <span class="text-stone-400">· {fileRate(speed.avgFilesPerSec)}</span>
						</dd>
					</div>
					<div>
						<dt class="text-xs text-stone-500">Waiting to upload</dt>
						<dd class="text-stone-100 tabular-nums">
							{int(speed.pending)} pages{#if speed.etaMs !== null}<span class="text-stone-400"> · ETA {duration(speed.etaMs)}</span
								>{:else if speed.pace === 'behind'}<span class="text-amber-300"> · growing</span>{/if}
						</dd>
					</div>
					<div>
						<dt class="text-xs text-stone-500">Pages <span class="text-stone-600">· last 5 minutes</span></dt>
						<dd class="text-stone-100 tabular-nums">
							{#if speed.pace === null}–{:else}
								<span title="Pages rendered a minute">{run.done < run.total ? `render ${perMinute(speed.renderPagesPerSec)}` : 'rendering done'}</span>
								<span class="text-stone-400" title="Pages uploaded a minute">· upload {perMinute(speed.uploadPagesPerSec)}</span>
							{/if}
						</dd>
					</div>
				</dl>
				{#if speed.pace}
					<p class="text-sm {PACE[speed.pace].tone}" role="status">{PACE[speed.pace].text}.</p>
				{/if}
			{/if}
			<p class="text-xs text-stone-500">
				Rendered pages go up as they finish: tiles, overview, page data and sidecar, then the print's index. Pages waiting include ones
				rendered before this run that weren't up yet.
			</p>
			{#if run.upload_failed > 0}
				<p class="text-sm text-rose-300">{int(run.upload_failed)} pages failed to upload and are retried (the next run tries again too).</p>
			{/if}
			{#if run.upload_error}
				<p class="text-xs text-stone-400">
					<span class="text-stone-500">Last upload error:</span>
					<span class="font-mono break-words">{run.upload_error}</span>
				</p>
			{/if}
		</section>
	{/if}

	<!-- Speed, storage, skips -->
	<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
		<section class="{card} space-y-1" aria-label="Speed">
			<h3 class={label}>Speed</h3>
			{#if ended}
				<p class="text-lg text-stone-100 tabular-nums">{run.done > 0 && took > 0 ? (pageRate(run.done / (took / 1000)) ?? '–') : '–'}</p>
				<p class="text-sm text-stone-500">average over {duration(took)}</p>
			{:else if runState === 'crashed'}
				<p class="text-lg text-stone-400">–</p>
				<p class="text-sm text-stone-500">no heartbeat; last measured {rate ?? 'nothing'}</p>
			{:else if run.total > 0 && run.done >= run.total && runState !== 'starting'}
				<p class="text-lg text-stone-100">rendering done</p>
				<p class="text-sm text-stone-500">{run.upload_target && run.uploads_pending > 0 ? 'uploads still going' : 'finishing up'}</p>
			{:else}
				<p class="text-lg text-stone-100 tabular-nums">{runState === 'paused' ? 'paused' : (rate ?? 'measuring…')}</p>
				<p class="text-sm text-stone-500">over the last 5 minutes</p>
			{/if}
		</section>

		<section class="{card} space-y-1" aria-label="Written">
			<h3 class={label}>Written</h3>
			<p class="text-lg text-stone-100 tabular-nums">{bytes(run.bytes)} <span class="text-sm text-stone-400">· {int(run.files)} files</span></p>
			{#if avg.perPage !== null}
				<p class="text-sm text-stone-500">
					{bytes(avg.perPage)} and {+(avg.filesPerPage ?? 0).toFixed(1)} files per rendered page
				</p>
				{#if avg.perPrint !== null}
					<p class="text-sm text-stone-500">{bytes(avg.perPrint)} per print, over the {int(avg.prints)} with a page rendered</p>
				{/if}
			{:else}
				<p class="text-sm text-stone-500">Nothing rendered yet.</p>
			{/if}
			<p class="text-xs text-stone-500">Unique tiles only: a tile that repeats within a print is stored once.</p>
		</section>

		<section class="{card} space-y-1" aria-label="Projected storage">
			<h3 class={label}>Projected storage</h3>
			{#if ended}
				<p class="text-lg text-stone-100 tabular-nums">{bytes(run.bytes)}</p>
				<p class="text-sm text-stone-500">final{left > 0 ? `; ${int(left)} pages were not reached` : ''}</p>
			{:else if proj && proj.left > 0}
				<p class="text-lg text-stone-100 tabular-nums">≈ {bytes(run.bytes + proj.likely)}</p>
				<p class="text-sm text-stone-500">
					for the run: {bytes(run.bytes)} so far + {bytes(proj.likely)} for {int(proj.left)} pages left
				</p>
				<p class="text-xs text-stone-500">
					{bytes(proj.perPage)} per rendered page × pages left × the {percent(run.rendered, run.done)} that rendered so far (at most {bytes(
						run.bytes + proj.upTo
					)} if every page left renders). Big pages and books skew it; tiles shared within a print make later pages cheaper.
				</p>
			{:else if proj}
				<p class="text-lg text-stone-100 tabular-nums">{bytes(run.bytes)}</p>
				<p class="text-sm text-stone-500">every page is done</p>
			{:else}
				<p class="text-lg text-stone-400">–</p>
				<p class="text-sm text-stone-500">Projected once a page has rendered.</p>
			{/if}
		</section>

		<section class="{card} space-y-2" aria-label="Skipped by reason">
			<h3 class={label}>Skipped by reason</h3>
			{#if skipReasons.length === 0}
				<p class="text-sm text-stone-500">None{run.skipped > 0 ? ' recorded on its pages' : ''}.</p>
			{:else}
				<ReasonBars reasons={skipReasons} bar="bg-amber-500/70" />
				<a href="#skipped" class="text-xs text-amber-400 hover:text-amber-300">See the pages ↓</a>
			{/if}
		</section>
	</div>
</article>
