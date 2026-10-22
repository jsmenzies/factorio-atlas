<script lang="ts">
	import type { RenderRun } from '#lib/server/admin/render.js';
	import { ago, bytes, clock, duration, elapsed, eta, int, isLiveState, percent, shownState, when } from '../metrics.js';
	import StateBadge from '../StateBadge.svelte';
	import {
		byteRate,
		fileRate,
		pageRate,
		perMinute,
		printProgress,
		RENDER_OUTCOMES,
		renderOptionChips,
		storageProjection,
		uploadProgress,
		uploadSpeed,
		writtenAverages
	} from './metrics.js';
	import RenderControls from './RenderControls.svelte';
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
	const avg = $derived(writtenAverages(run));
	const speed = $derived(uploadSpeed(run, took, live && runState !== 'paused'));
	const PACE = {
		idle: { text: 'Uploads are up to date', tone: 'text-emerald-300' },
		'keeping-up': { text: 'Uploads are keeping up with rendering', tone: 'text-emerald-300' },
		behind: { text: 'Uploads are falling behind: rendering is faster, so the backlog grows', tone: 'text-amber-300' },
		stalled: { text: 'Pages are waiting but none went up in the last 5 minutes', tone: 'text-amber-300' },
		draining: { text: 'Rendering is done; uploading what is left', tone: 'text-sky-300' }
	} as const;
	const skipMax = $derived(Math.max(1, ...skipReasons.map(([, n]) => n)));

	const card = 'rounded-lg border border-stone-800 bg-stone-900/50 p-4';
	const label = 'text-xs font-medium tracking-wide text-stone-500 uppercase';
</script>

<article class="space-y-5">
	<!-- What this run is -->
	<header class="space-y-2">
		<div class="flex flex-wrap items-center gap-2">
			<h2 class="text-xl font-semibold text-stone-100">
				{#if href}<a {href} class="hover:text-amber-300">Render run</a>{:else}Render run{/if}
			</h2>
			<StateBadge state={runState} />
		</div>
		<p class="flex flex-wrap gap-x-3 gap-y-1 text-sm text-stone-400">
			<span>Started {when(run.started_at, now, timeZone)}</span>
			<span class="text-stone-600" aria-hidden="true">·</span>
			<span>{ended ? 'took' : runState === 'crashed' ? 'ran for' : 'running for'} {duration(took)}</span>
			{#if !ended}
				<span class="text-stone-600" aria-hidden="true">·</span>
				<span class={runState === 'crashed' ? 'text-rose-300' : ''}>last heartbeat {ago(now - run.updated_at)}</span>
			{:else if run.finished_at}
				<span class="text-stone-600" aria-hidden="true">·</span>
				<span>ended {when(run.finished_at, now, timeZone)}</span>
			{/if}
		</p>
		<p class="flex flex-wrap items-center gap-1.5 text-xs text-stone-400">
			<span class="rounded bg-stone-800 px-1.5 py-0.5" title="Host">{run.host}</span>
			<span class="rounded bg-stone-800 px-1.5 py-0.5 font-mono" title="Source">{run.source}</span>
			{#each chips as chip (chip)}<span class="rounded bg-stone-800 px-1.5 py-0.5">{chip}</span>{/each}
			<span class="font-mono text-stone-600" title="Run id">{run.id}</span>
		</p>
	</header>

	{#if runState === 'crashed'}
		<div class="rounded-lg border border-rose-800/70 bg-rose-950/40 p-4 text-sm" role="alert">
			<p class="font-medium text-rose-200">
				Renderer not responding since {clock(run.updated_at, now, timeZone)} ({ago(now - run.updated_at)}).
			</p>
			<p class="mt-1 text-rose-200/80">
				It may have crashed or the machine may be asleep. If it comes back it carries on (and acts on any request below). Otherwise run
				<code>bun run render --resume</code>: pages left mid-render go back in the queue, rendered ones are never drawn again, and pages
				that were going up are uploaded again.
			</p>
		</div>
	{/if}
	{#if run.state === 'failed' && run.error}
		<div class="rounded-lg border border-rose-800/70 bg-rose-950/40 p-4 text-sm" role="alert">
			<p class="font-medium text-rose-200">The run failed</p>
			<p class="mt-1 font-mono text-xs break-words whitespace-pre-wrap text-rose-200/80">{run.error}</p>
		</div>
	{/if}

	{#if controls}<RenderControls {run} {heartbeatMs} {message} />{/if}

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
		<dl class="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
			{#each RENDER_OUTCOMES as o (o.key)}
				{@const n = run[o.key]}
				<div class="flex items-start gap-2 {n === 0 ? 'opacity-45' : ''}">
					<span class="mt-1.5 size-2.5 shrink-0 rounded-sm {o.color}" aria-hidden="true"></span>
					<div class="min-w-0">
						<dt class="text-stone-200">
							{o.label}
							<span class="ml-1 text-stone-100 tabular-nums">{int(n)}</span>
							{#if n > 0 && run.done > 0}<span class="text-xs text-stone-500"> {percent(n, run.done)}</span>{/if}
						</dt>
						<dd class="text-xs text-stone-500">{o.hint}</dd>
					</div>
				</div>
			{/each}
		</dl>
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
				<ul class="space-y-1.5 text-sm">
					{#each skipReasons as [reason, n] (reason)}
						<li>
							<div class="flex justify-between gap-2">
								<span class="truncate font-mono text-xs text-stone-300" title={reason}>{reason}</span>
								<span class="text-stone-100 tabular-nums">{int(n)}</span>
							</div>
							<div class="mt-0.5 h-1 overflow-hidden rounded-full bg-stone-800">
								<div class="h-full rounded-full bg-amber-500/70" style="width: {(n / skipMax) * 100}%"></div>
							</div>
						</li>
					{/each}
				</ul>
				<a href="#skipped" class="text-xs text-amber-400 hover:text-amber-300">See the pages ↓</a>
			{/if}
		</section>
	</div>
</article>
