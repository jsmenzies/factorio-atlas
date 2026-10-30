<script lang="ts">
	import { invalidate } from '$app/navigation';
	import type { RenderScopes } from '#lib/server/admin/render-scope.js';
	import type { RenderTotals } from '#lib/server/admin/sync.js';
	import type { SyncFigures, SyncPlan } from '#lib/sync.js';
	import { PIPELINE_DEP } from '../live.svelte.js';
	import { ago, bytes, int, percent, when } from '../metrics.js';
	import { shortCommit, sourceMoved } from './view.js';

	/**
	 * The figures at a glance: the site's prints and screenshots (as counted at the end of the last
	 * update, or by Refresh), the renders (the local queue), the mirror (the last check), then render
	 * coverage as one bar.
	 */
	let {
		figures,
		plan,
		scopes,
		totals,
		now,
		timeZone
	}: { figures: SyncFigures | null; plan: SyncPlan | null; scopes: RenderScopes; totals: RenderTotals; now: number; timeZone: string } = $props();

	let refreshing = $state(false);
	let error = $state<string | null>(null);
	const refresh = async () => {
		refreshing = true;
		error = null;
		try {
			const res = await fetch('/admin/__sync/figures', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
			const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
			if (!res.ok || !out.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
			await invalidate(PIPELINE_DEP);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			refreshing = false;
		}
	};

	const u = $derived(scopes.union);
	/** Prints in the sources at their latest (a print in two sources counts twice, for now). */
	const sourcePrints = $derived((plan?.sources ?? []).reduce((n, p) => n + p.prints, 0));
	const versions = $derived(figures ? Object.entries(figures.analysed).sort(([a], [b]) => Number(b) - Number(a)) : []);
	const bar = $derived([
		{ n: u.rendered, label: 'Rendered', class: 'bg-emerald-600' },
		{ n: u.none, label: "Can't be drawn (modded, empty or undecodable)", class: 'bg-amber-700' },
		{ n: u.failed, label: 'Failed', class: 'bg-rose-600' },
		{ n: u.left, label: 'Left to render', class: 'bg-stone-500' }
	]);

	const card = 'rounded-lg border border-stone-800 bg-stone-900/50 p-4';
	const label = 'text-xs font-semibold tracking-wide text-stone-500 uppercase';
	const big = 'text-2xl font-semibold text-stone-100 tabular-nums';
	const row = 'flex justify-between gap-3 text-sm';
</script>

<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
	<section class={card}>
		<p class={label}>Site prints</p>
		{#if figures}
			<p class={big}>{int(figures.prints)}</p>
			<p class="text-xs text-stone-500">{plan?.sources.length ? `of ${int(sourcePrints)} in the sources · ` : ''}{figures.stage}</p>
			<dl class="mt-2 space-y-0.5">
				<div class={row}>
					<dt class="text-stone-500">Analysis</dt>
					<dd class="text-right tabular-nums">
						{#each versions as [v, count], i (v)}{i ? ', ' : ''}<span class={i ? 'text-amber-200' : 'text-emerald-300'}>v{v} {int(count)}</span>{/each}
					</dd>
				</div>
				<div class={row}><dt class="text-stone-500">Failed to read</dt><dd class="tabular-nums">{int(figures.failed)}</dd></div>
				<div class={row}>
					<dt class="text-stone-500">No author name</dt><dd class="tabular-nums {figures.unnamed ? 'text-amber-200' : ''}">{int(figures.unnamed)}</dd>
				</div>
			</dl>
		{:else}
			<p class="mt-1 text-sm text-stone-400">Not counted yet: an update counts them at its end.</p>
		{/if}
	</section>

	<section class={card}>
		<p class={label}>Renders</p>
		<p class={big}>{int(u.rendered)} <span class="text-sm font-normal text-stone-500">prints</span></p>
		<p class="text-xs text-stone-500">
			{int(totals.pages)} pages · {totals.uploaded === totals.pages ? 'all on prod' : `${int(totals.uploaded)} on prod`}
		</p>
		<dl class="mt-2 space-y-0.5">
			<div class={row}><dt class="text-stone-500">Left to render</dt><dd class="tabular-nums {u.left ? 'text-stone-100' : 'text-emerald-300'}">{int(u.left)}</dd></div>
			<div class={row}><dt class="text-stone-500">Can't be drawn</dt><dd class="tabular-nums">{int(u.none)}</dd></div>
			<div class={row}><dt class="text-stone-500">Failed</dt><dd class="tabular-nums {totals.failed ? 'text-rose-300' : ''}">{int(totals.failed)} page{totals.failed === 1 ? '' : 's'}</dd></div>
			<div class={row}><dt class="text-stone-500">On disk</dt><dd class="tabular-nums">{bytes(totals.bytes)}</dd></div>
		</dl>
	</section>

	<section class={card}>
		<p class={label}>Screenshots</p>
		{#if figures}
			<p class={big}>{int(figures.screenshots.copied ?? 0)}</p>
			<p class="text-xs text-stone-500">copied, on {figures.stage}</p>
			<dl class="mt-2 space-y-0.5">
				<div class={row}><dt class="text-stone-500">Dead on Imgur</dt><dd class="tabular-nums">{int(figures.screenshots.dead ?? 0)}</dd></div>
				<div class={row}><dt class="text-stone-500">Removed</dt><dd class="tabular-nums">{int(figures.screenshots.removed ?? 0)}</dd></div>
				<div class={row}>
					<dt class="text-stone-500">Prints without one</dt>
					<dd class="tabular-nums">{int(Math.max(0, figures.prints - Object.values(figures.screenshots).reduce((a, b) => a + b, 0)))}</dd>
				</div>
			</dl>
		{:else}
			<p class="mt-1 text-sm text-stone-400">Not counted yet.</p>
		{/if}
	</section>

	<section class={card}>
		<p class={label}>Sources</p>
		{#if plan && plan.sources.length}
			{#each plan.sources as source, i (source.site)}
				{#if source.error || source.position}
					<!-- A source whose cursor isn't a commit (uploads): what waits, in its own words. -->
					<p class="text-2xl font-semibold text-stone-100 {i ? 'mt-3' : ''}">{source.error ? '?' : source.off ? 'off' : int(source.added + (source.polled ? source.edited : 0))}</p>
					<p class="text-xs text-stone-500">{source.site} {source.polled ? 'to read' : 'waiting'} · {source.error ? `couldn’t check: ${source.error}` : source.position}</p>
				{:else}
					<p class="text-2xl font-semibold text-stone-100"><code>{shortCommit(source.from.id)}</code></p>
					<p class="text-xs text-stone-500">{source.site}, from {when(source.from.date, now, timeZone)}</p>
					<dl class="mt-2 space-y-0.5">
						<div class={row}><dt class="text-stone-500">Latest</dt><dd><code>{shortCommit(source.to.id)}</code></dd></div>
						<div class={row}>
							<dt class="text-stone-500">Waiting</dt>
							<dd class="tabular-nums {source.blocked ? 'text-rose-300' : source.added || source.edited ? 'text-amber-200' : 'text-emerald-300'}">
								{source.blocked ? 'held back' : !sourceMoved(source) ? 'nothing' : `${int(source.added)} new, ${int(source.edited)} edited`}
							</dd>
						</div>
					</dl>
				{/if}
			{/each}
			<p class="mt-1 text-xs text-stone-500">Checked {ago(now - plan.checkedAt)}</p>
		{:else}
			<p class="mt-1 text-sm text-stone-400">Not checked yet.</p>
		{/if}
	</section>
</div>

<p class="mt-2 flex flex-wrap items-center gap-x-3 text-xs text-stone-500">
	<span>{figures ? `Site figures counted ${ago(now - figures.at)}.` : ''}</span>
	<button type="button" onclick={refresh} disabled={refreshing} class="rounded border border-stone-800 px-2 py-0.5 text-stone-400 hover:text-stone-200 disabled:cursor-wait">
		{refreshing ? 'Counting…' : 'Count again'}
	</button>
	{#if error}<span class="text-rose-300" role="alert">{error}</span>{/if}
</p>

<section class="{card} mt-3" aria-labelledby="coverage-title">
	<div class="flex flex-wrap items-baseline justify-between gap-2">
		<h2 id="coverage-title" class={label}>Render coverage · prints in scope</h2>
		<p class="text-xs text-stone-500">
			{int(scopes.modern.total)} with a 2.0+ page{scopes.favorites ? ` + the top ${int(scopes.favorites.n)} (≥ ${int(scopes.favorites.cutoff)} favourites)` : ''}
			= {int(u.total)}
		</p>
	</div>
	<div class="mt-3 flex h-5 overflow-hidden rounded-md bg-stone-800" role="img" aria-label={bar.map((b) => `${b.label} ${int(b.n)}`).join(', ')}>
		{#each bar as b (b.label)}
			{#if b.n}<span class="block h-full {b.class}" style="width: {percent(b.n, u.total || 1)}" title="{b.label}: {int(b.n)}"></span>{/if}
		{/each}
	</div>
	<ul class="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-stone-400">
		{#each bar as b (b.label)}
			<li><span class="mr-1.5 inline-block size-2.5 rounded-sm align-[-1px] {b.class}"></span>{b.label} {int(b.n)}{u.total ? ` (${percent(b.n, u.total)})` : ''}</li>
		{/each}
	</ul>
	<div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
		{#each [{ n: plan?.sources.length ? sourcePrints : undefined, t: 'in the sources' }, { n: figures?.prints, t: 'on the site' }, { n: u.total, t: 'in render scope' }, { n: u.rendered, t: 'rendered' }] as f (f.t)}
			<div class="rounded-md border border-stone-800 px-3 py-2">
				<p class="text-lg font-semibold text-stone-100 tabular-nums">{f.n === undefined ? '—' : int(f.n)}</p>
				<p class="text-xs text-stone-500">{f.t}</p>
			</div>
		{/each}
	</div>
</section>
