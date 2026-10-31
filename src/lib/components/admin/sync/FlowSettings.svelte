<script lang="ts">
	import type { ScopeFigures } from '#lib/server/admin/render-scope.js';
	import { HOLD_FLOOR, MEM_CAP_MIN_MB, memCapMaxMb, type SyncSettings } from '#lib/sync.js';
	import { bytes, duration, int } from '../metrics.js';
	import Toggle from './Toggle.svelte';

	/**
	 * How the next update runs, under the flow: the steps that can be turned off (authors, screenshots, render)
	 * with their settings beside them, and the change guard folded under Advanced. The polled sites' switches
	 * are on their lanes. Settings are bound and saved by the page on `onchange`; while an update runs they
	 * are one locked line (an update reads them when it starts). Render's top N says what that N adds to the
	 * render scope (`sync --top-preview`, read-only, ≈ 1 s).
	 */
	let {
		settings = $bindable(),
		live,
		union,
		modern,
		ramMb,
		errors,
		onchange
	}: {
		settings: SyncSettings;
		live: boolean;
		union: ScopeFigures;
		/** Prints with a 2.0+ page: always in the render scope. */
		modern: number;
		/** This machine's RAM: the memory cap's upper bound. */
		ramMb: number;
		errors: readonly string[];
		onchange: () => void;
	} = $props();

	type TopPreview = {
		n: number;
		cutoff: number;
		adds: number;
		estimate: { pages: number; dollars: number; bytes: number; storagePerMonth: number; seconds: number };
	};
	let top = $state<TopPreview | null>(null);
	let topError = $state<string | null>(null);
	$effect(() => {
		const n = settings.top;
		if (live || !Number.isInteger(n) || n < 0 || n > 100_000) return;
		const timer = setTimeout(async () => {
			try {
				const res = await fetch('/admin/__sync/top-preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n }) });
				const out = (await res.json()) as { ok?: boolean; error?: string; result?: TopPreview };
				if (!res.ok || !out.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
				top = out.result ?? null;
				topError = null;
			} catch (e) {
				topError = e instanceof Error ? e.message : String(e);
			}
		}, 400);
		return () => clearTimeout(timer);
	});

	// The memory cap is in MB; the field is GB with one decimal.
	const gb = (mb: number) => Math.round((mb / 1024) * 10) / 10;
	const capMax = $derived(memCapMaxMb(ramMb));
	let capGb = $state<number | null>(null);
	$effect.pre(() => {
		if (capGb === null) capGb = gb(settings.memCapMb);
	});

	// The change guard is a share; the field is a percentage.
	let pct = $state<number | null>(null);
	$effect.pre(() => {
		if (pct === null) pct = Math.round(settings.maxChange * 100);
	});

	/** A number field: typing updates the setting (blank: null); committing it (Enter, leaving) saves. */
	const numberInput = (e: Event & { currentTarget: HTMLInputElement }) => {
		const v = e.currentTarget.value.trim();
		return v === '' ? null : Number(v);
	};
	const field = (name: string) =>
		`w-20 rounded-md border bg-stone-950 px-2 py-1 text-right text-sm text-stone-100 tabular-nums ${errors.includes(name) ? 'border-rose-500' : 'border-stone-700'}`;
	const row = 'flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-stone-800 py-2.5';
	const lbl = 'inline-flex items-center gap-1.5 text-sm text-stone-400';
</script>

{#if live}
	<p class="rounded-lg border border-stone-800 bg-stone-900/50 px-4 py-2.5 text-xs text-stone-500">
		Settings are locked while the update runs (it read them when it started): authors {settings.authors ? 'on' : 'off'} · screenshots
		{settings.screenshots ? 'on' : 'off'} · render {settings.render
			? `on, top ${int(settings.top)}, ${settings.perUpdate === null ? 'every print with work' : `≤ ${int(settings.perUpdate)} prints`}, ${settings.workers ?? 'default'} threads, ${gb(settings.memCapMb)} GB per worker${settings.retryFailed ? ', retrying failed pages' : ''}`
			: 'off'} · hold back at {Math.round(settings.maxChange * 100)}% · codex {settings.polled.codex.on ? 'on' : 'off'} · fprints {settings.polled.fprints.on ? 'on' : 'off'}
	</p>
{:else}
	<section aria-labelledby="settings-title" class="rounded-lg border border-stone-800 bg-stone-900/50 px-4 pt-3 pb-1">
		<h2 id="settings-title" class="pb-2 text-xs font-semibold tracking-wide text-stone-500 uppercase">How the next update runs</h2>

		<div class={row}>
			<div class="min-w-0 flex-1 basis-60">
				<p class="text-sm font-medium text-stone-100">Name new authors <span class="font-normal text-stone-500">· factorioprints only</span></p>
				<p class="text-xs text-stone-500">Their records first, then Firebase, once per author, ever.</p>
			</div>
			<Toggle bind:checked={settings.authors} label="Name new authors" {onchange} />
		</div>

		<div class={row}>
			<div class="min-w-0 flex-1 basis-60">
				<p class="text-sm font-medium text-stone-100">Copy screenshots <span class="font-normal text-stone-500">· Imgur, uploads and other sites’ images</span></p>
				<p class="text-xs text-stone-500">At most 4 requests a second to Imgur; then sized and uploaded, and the cards updated.</p>
			</div>
			<Toggle bind:checked={settings.screenshots} label="Copy screenshots" {onchange} />
		</div>

		<div class={row}>
			<div class="min-w-0 flex-1 basis-60">
				<p class="text-sm font-medium text-stone-100">Render and upload <span class="font-normal text-stone-500">· one run for every source</span></p>
				<p class="text-xs text-stone-500 tabular-nums">
					In scope {int(union.total)} (every 2.0+ print, {int(modern)}, plus the top favourites) · rendered {int(union.rendered)} · left {int(union.left)} · can’t be drawn
					{int(union.none)}{union.failed ? ` · failed ${int(union.failed)}` : ''}
				</p>
			</div>
			<div class="flex flex-wrap items-center gap-x-3 gap-y-2 {settings.render ? '' : 'opacity-50'}">
				<label class={lbl} title="The N most-favourited prints are rendered too, older ones included. A print that drops out keeps its renders. 0: no top list.">
					Top ★
					<input id="top" type="number" min="0" max="100000" step="1" value={settings.top} class={field('top')} oninput={(e) => (settings.top = numberInput(e) as number)} onchange={() => onchange()} />
				</label>
				<label class={lbl} title="The rest wait for the next update. Blank: every print with work.">
					Most per update
					<input id="perUpdate" type="number" min="1" max="100000" step="1" placeholder="all" value={settings.perUpdate ?? ''} class={field('perUpdate')} oninput={(e) => (settings.perUpdate = numberInput(e))} onchange={() => onchange()} />
				</label>
				<label class={lbl} title="Blank: half the CPU threads. 8 suits this machine (see the memory notes).">
					Threads
					<input id="workers" type="number" min="1" max="64" step="1" placeholder="auto" value={settings.workers ?? ''} class="{field('workers')} w-16" oninput={(e) => (settings.workers = numberInput(e))} onchange={() => onchange()} />
				</label>
				<label class={lbl} title="A worker is stopped past this much memory and its page retried. From {gb(MEM_CAP_MIN_MB)} GB to {Math.floor((capMax / 1024) * 10) / 10} GB (this machine’s RAM less what the render keeps free). 6 GB by default.">
					Memory per worker (GB)
					<input
						id="memCapMb"
						type="number"
						min={gb(MEM_CAP_MIN_MB)}
						max={Math.floor((capMax / 1024) * 10) / 10}
						step="0.1"
						value={capGb ?? ''}
						class="{field('memCapMb')} w-16"
						oninput={(e) => (capGb = numberInput(e))}
						onchange={() => {
							settings.memCapMb = capGb === null ? Number.NaN : Math.round(capGb * 1024);
							onchange();
						}}
					/>
				</label>
				<label class="{lbl} cursor-pointer" title="The next update also redraws pages that failed every attempt, taking their prints first; cleared once the render step has drawn.">
					<input id="retryFailed" type="checkbox" bind:checked={settings.retryFailed} onchange={() => onchange()} class="accent-amber-500" />
					Retry failed pages: next update only
				</label>
			</div>
			<Toggle bind:checked={settings.render} label="Render and upload" {onchange} />
			{#if top && top.n === settings.top}
				<p class="basis-full text-xs text-stone-400">
					Top {int(top.n)} = ≥ {int(top.cutoff)} favourites ·
					{#if top.adds}
						adds <b class="font-semibold text-amber-200">{int(top.adds)} prints</b> to the scope: ≈ {int(top.estimate.pages)} pages, ≈ {duration(top.estimate.seconds * 1000)} to
						render, ≈ ${top.estimate.dollars.toFixed(2)} to upload once, +{bytes(top.estimate.bytes)} (≈ ${top.estimate.storagePerMonth.toFixed(2)}/month)
					{:else}
						every one already in scope
					{/if}
				</p>
			{:else if topError}
				<p class="basis-full text-xs text-rose-300">{topError}</p>
			{/if}
		</div>

		<details class="group border-t border-stone-800 py-2">
			<summary class="flex cursor-pointer list-none items-center gap-1.5 text-xs text-stone-500 [&::-webkit-details-marker]:hidden">
				<span class="transition-transform group-open:rotate-90" aria-hidden="true">▸</span> Advanced
			</summary>
			<label class="mt-2 flex flex-wrap items-center gap-1.5 text-sm text-stone-400">
				Hold back a source when more than
				<input
					id="maxChange"
					type="number"
					min="1"
					max="100"
					step="1"
					value={pct ?? ''}
					class="{field('maxChange')} w-16"
					oninput={(e) => (pct = numberInput(e))}
					onchange={() => {
						settings.maxChange = pct === null ? Number.NaN : pct / 100;
						onchange();
					}}
				/>
				% of its prints (at least {HOLD_FLOOR} prints) are new or removed in one update
			</label>
			<p class="mt-1 text-xs text-stone-500">
				The same rule for the mirror (its moved files count too, as in the layout change of 11 Oct) and the other sites; edits never count. A first import is held
				back once. A held-back source shows Accept in its Changes cell.
			</p>
		</details>
	</section>
{/if}
