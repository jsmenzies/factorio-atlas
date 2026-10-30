<script lang="ts">
	import { invalidate } from '$app/navigation';
	import type { RenderScopes } from '#lib/server/admin/render-scope.js';
	import type { RenderTotals } from '#lib/server/admin/sync.js';
	import { SITES, type Site } from '#lib/print-id.js';
	import { SOURCE_SITES } from '#lib/sources.js';
	import type { SyncFigures } from '#lib/sync.js';
	import { PIPELINE_DEP } from '../live.svelte.js';
	import { ago, bytes, int, percent } from '../metrics.js';

	/**
	 * The Overview's figures: the site's prints by the source they are credited to, analysis and
	 * screenshots (as the last update, or Count again, counted them on the stage: sync_meta 'figures'),
	 * then render coverage (the local render queue) as one bar.
	 */
	let {
		figures,
		scopes,
		totals,
		now
	}: { figures: SyncFigures | null; scopes: RenderScopes; totals: RenderTotals; now: number } = $props();

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
	const versions = $derived(figures ? Object.entries(figures.analysed).sort(([a], [b]) => Number(b) - Number(a)) : []);
	const folded = $derived(figures?.bySource ? Object.values(figures.bySource).reduce((n, s) => n + s.folded, 0) : null);
	/** Every site, in the site table's order, with what the figures have for it (sites without prints too, when counted). */
	const sources = $derived.by(() => {
		const by = figures?.bySource;
		if (!by) return [];
		const known = new Set<string>(SITES);
		const sites = [...SITES, ...Object.keys(by).filter((s) => !known.has(s))];
		const max = Math.max(1, ...Object.values(by).map((s) => s.prints));
		return sites.map((site) => {
			const c = by[site] ?? { prints: 0, folded: 0 };
			const records = figures?.sourceRecords?.[site] ?? 0;
			return {
				site,
				name: SOURCE_SITES[site as Site]?.name ?? site,
				prints: c.prints,
				folded: c.folded,
				// Posts on that site joined to a print credited elsewhere ("Also on …").
				joined: Math.max(0, records - c.prints),
				width: c.prints ? Math.max(0.5, (c.prints / max) * 100) : 0
			};
		});
	});
	const shots = $derived(figures ? Object.values(figures.screenshots).reduce((a, b) => a + b, 0) : 0);
	const bar = $derived([
		{ n: u.rendered, label: 'Rendered', class: 'bg-emerald-600' },
		{ n: u.none, label: "Can't be drawn", class: 'bg-amber-700' },
		{ n: u.failed, label: 'Failed', class: 'bg-rose-600' },
		{ n: u.left, label: 'Left to render', class: 'bg-stone-500' }
	]);

	const card = 'rounded-lg border border-stone-800 bg-stone-900/50 p-4';
	const label = 'text-xs font-semibold tracking-wide text-stone-500 uppercase';
	const row = 'flex justify-between gap-3 text-sm';
</script>

<section aria-labelledby="site-title" class="space-y-3">
	<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
		<h2 id="site-title" class={label}>What the site has{figures ? ` · ${figures.stage}` : ''}</h2>
		<p class="flex flex-wrap items-center gap-x-3 text-xs text-stone-500">
			<span>{figures ? `Counted ${ago(now - figures.at)}, at the end of the last update` : 'Not counted yet: an update counts at its end'}</span>
			<button type="button" onclick={refresh} disabled={refreshing} class="rounded border border-stone-800 px-2 py-0.5 text-stone-400 hover:text-stone-200 disabled:cursor-wait">
				{refreshing ? 'Counting…' : 'Count again'}
			</button>
			{#if error}<span class="text-rose-300" role="alert">{error}</span>{/if}
		</p>
	</div>

	<!-- The headline numbers. -->
	<dl class="grid grid-cols-2 gap-3 lg:grid-cols-4">
		{#each [{ t: 'prints on the site', n: figures?.prints, sub: folded ? `${int(figures!.prints - folded)} listed, ${int(folded)} folded copies` : null }, { t: 'with a render', n: figures?.rendered ?? u.rendered, sub: `${int(totals.pages)} pages · ${totals.uploaded === totals.pages ? 'all on prod' : `${int(totals.uploaded)} on prod`}` }, { t: 'screenshots copied', n: figures?.screenshots.copied, sub: figures ? `${int(figures.screenshots.dead ?? 0)} dead on Imgur · ${int(figures.screenshots.removed ?? 0)} removed` : null }, { t: 'failed to read', n: figures?.failed, sub: 'known failures, skipped by updates' }] as f (f.t)}
			<div class="{card} flex flex-col-reverse">
				<dt class="text-sm text-stone-400">
					{f.t}
					{#if f.sub}<span class="block text-xs text-stone-500">{f.sub}</span>{/if}
				</dt>
				<dd class="text-2xl font-semibold text-stone-100 tabular-nums">{f.n === undefined ? '—' : int(f.n)}</dd>
			</div>
		{/each}
	</dl>

	<div class="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
		<section class={card} aria-labelledby="by-source-title">
			<h3 id="by-source-title" class={label}>Prints by source</h3>
			{#if sources.length}
				<ul class="mt-2 space-y-2">
					{#each sources as s (s.site)}
						<li>
							<div class="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
								<span class="text-stone-200">{s.name}{s.site === 'upload' ? ' uploads' : ''}</span>
								<span class="text-stone-100 tabular-nums">{int(s.prints)}</span>
							</div>
							<div class="mt-1 h-1.5 overflow-hidden rounded-full bg-stone-800">
								<div class="h-full rounded-full bg-amber-500/80" style="width: {s.width}%"></div>
							</div>
							{#if s.joined || s.folded}
								<p class="mt-0.5 text-xs text-stone-500">
									{[s.joined ? `+${int(s.joined)} joined prints from elsewhere ("Also on")` : '', s.folded ? `${int(s.folded)} folded copies` : ''].filter(Boolean).join(' · ')}
								</p>
							{/if}
						</li>
					{/each}
				</ul>
			{:else}
				<p class="mt-2 text-sm text-stone-400">Not counted by source yet: the next update (or Count again) counts them.</p>
			{/if}
		</section>

		<section class={card} aria-labelledby="analysis-title">
			<h3 id="analysis-title" class={label}>Analysis and screenshots</h3>
			{#if figures}
				<dl class="mt-2 space-y-1">
					<div class={row}>
						<dt class="text-stone-400">Analyser version</dt>
						<dd class="text-right tabular-nums">
							{#each versions as [v, count], i (v)}{i ? ', ' : ''}<span class={i ? 'text-amber-200' : 'text-emerald-300'}>v{v} {int(count)}</span>{/each}
						</dd>
					</div>
					<div class={row}>
						<dt class="text-stone-400">factorioprints prints with no author name</dt><dd class="tabular-nums {figures.unnamed ? 'text-amber-200' : ''}">{int(figures.unnamed)}</dd>
					</div>
					<div class={row}><dt class="text-stone-400">Screenshots dead on Imgur</dt><dd class="tabular-nums">{int(figures.screenshots.dead ?? 0)}</dd></div>
					<div class={row}><dt class="text-stone-400">Screenshots removed</dt><dd class="tabular-nums">{int(figures.screenshots.removed ?? 0)}</dd></div>
					<div class={row}><dt class="text-stone-400">Prints without a screenshot</dt><dd class="tabular-nums">{int(Math.max(0, figures.prints - shots))}</dd></div>
					<div class={row}><dt class="text-stone-400">Renders on disk</dt><dd class="tabular-nums">{bytes(totals.bytes)}</dd></div>
				</dl>
			{:else}
				<p class="mt-2 text-sm text-stone-400">Not counted yet.</p>
			{/if}
		</section>
	</div>

	<section class={card} aria-labelledby="coverage-title">
		<div class="flex flex-wrap items-baseline justify-between gap-2">
			<h3 id="coverage-title" class={label}>Render coverage · prints in scope</h3>
			<p class="text-xs text-stone-500">
				{int(scopes.modern.total)} with a 2.0+ page{scopes.favorites ? ` + the top ${int(scopes.favorites.n)} (≥ ${int(scopes.favorites.cutoff)} favourites)` : ''}
				= {int(u.total)}
			</p>
		</div>
		<div class="mt-3 flex h-4 overflow-hidden rounded-md bg-stone-800" role="img" aria-label={bar.map((b) => `${b.label} ${int(b.n)}`).join(', ')}>
			{#each bar as b (b.label)}
				{#if b.n}<span class="block h-full {b.class}" style="width: {percent(b.n, u.total || 1)}" title="{b.label}: {int(b.n)}"></span>{/if}
			{/each}
		</div>
		<ul class="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-stone-400">
			{#each bar as b (b.label)}
				<li><span class="mr-1.5 inline-block size-2.5 rounded-sm align-[-1px] {b.class}"></span>{b.label} {int(b.n)}{u.total ? ` (${percent(b.n, u.total)})` : ''}</li>
			{/each}
		</ul>
	</section>
</section>
