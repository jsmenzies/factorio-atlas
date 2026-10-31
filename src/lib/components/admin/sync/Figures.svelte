<script lang="ts">
	import { invalidate } from '$app/navigation';
	import type { RenderScopes, SiteRender } from '#lib/server/admin/render-scope.js';
	import type { RenderTotals } from '#lib/server/admin/sync.js';
	import { R2_STORAGE_PER_GB_MONTH, type SyncFigures } from '#lib/sync.js';
	import { PIPELINE_DEP } from '../live.svelte.js';
	import { ago, int } from '../metrics.js';
	import { BUCKET_TEXT, NO_NAMES, NOT_APPLICABLE, r2Panel, siteTable, size, type SiteRow } from './site-figures.js';

	/**
	 * The Overview's "What the site has": headline cards, then one row per source (the site each print is credited
	 * to) with every figure out of that source's own prints, as the last update (or Count again) counted them on the
	 * stage (sync_meta 'figures'), render coverage from the local render queue by the same sites, and the site's R2
	 * storage as the figures step read it from Cloudflare's analytics.
	 */
	let {
		figures,
		scopes,
		siteRender,
		totals,
		now
	}: { figures: SyncFigures | null; scopes: RenderScopes; siteRender: Record<string, SiteRender>; totals: RenderTotals; now: number } = $props();

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

	const table = $derived(siteTable(figures, siteRender));
	const version = $derived(figures?.analyzerVersion ?? (figures ? Math.max(0, ...Object.keys(figures.analysed).map(Number)) : 0));
	const r2 = $derived(figures?.r2 && 'buckets' in figures.r2 ? r2Panel(figures.r2.buckets) : null);
	const r2Error = $derived(figures?.r2 && 'error' in figures.r2 ? figures.r2.error : null);
	const left = $derived(scopes.union.left);

	const cards = $derived([
		{ t: 'Prints on the site', n: figures ? int(figures.prints) : '—', sub: table ? `${table.rows.length} sources` : null },
		{ t: 'Listed in search', n: table ? int(table.total.listed) : '—', sub: table ? `${int(table.total.folded)} folded copies kept out` : null },
		{
			t: 'With a render',
			n: int(figures?.rendered ?? scopes.union.rendered),
			sub: [`${int(totals.pages)} book pages`, left ? `${int(left)} left` : '', table?.total.render.older ? `${int(table.total.render.older)} before 2.0` : '']
				.filter(Boolean)
				.join(' · ')
		},
		{ t: 'R2 storage', n: r2 ? `≈ ${size(r2.bytes)}` : '—', sub: r2 ? `≈ $${r2.dollars.toFixed(2)} a month` : r2Error ? 'couldn’t be read' : null }
	]);

	const HEADS = $derived([
		{ t: 'Prints', sub: '', tip: 'Prints on the site credited to this source: the site where the blueprint was posted first. Every “out of its prints” counts these.' },
		{ t: 'In search', sub: '', tip: 'Prints listed in search and the sitemap: all but folded copies (later exact copies of an earlier print, page kept).' },
		{ t: `Analysed (v${version})`, sub: 'out of its prints', tip: 'Prints analysed with today’s analyser and game data.' },
		{
			t: 'Author',
			sub: 'out of its prints',
			tip: 'Prints whose card names who made it. fprints gives no names; factoriobin posts are anonymous (n/a, left out of the total).'
		},
		{ t: 'Screenshot', sub: 'out of its prints', tip: 'Prints showing a screenshot (our own copy). factoriobin has none (n/a): its render stands in.' },
		{
			t: 'Rendered',
			sub: 'out of its prints we render',
			tip: 'We render prints with a page saved in Factorio 2.0 or later, plus factorioprints’ top favourites. “Before 2.0”: prints a render run looked at whose every page was saved before 2.0, not rendered. The bar: rendered, can’t be drawn (mods, empty, planners only), failed, waiting. From this machine’s render queue.'
		},
		{ t: 'Book pages drawn', sub: 'and their size on this machine', tip: 'Pages with a render: each page of a book is its own render. The size is their files on this machine.' },
		{
			t: 'Pulled',
			sub: 'posts fetched from the site',
			tip: 'Every post pulled from the site and still there. Duplicates of another site’s print show on it as “Also on”; duplicates on the same site join the first post; posts that couldn’t be read or were refused (blocked, too big) never became prints. “—”: not known on this machine.'
		}
	]);

	const card = 'rounded-lg border border-stone-800 bg-stone-900/50 p-4';
	const label = 'text-xs font-semibold tracking-wide text-stone-500 uppercase';
	const plural = (n: number, one: string, many: string) => `${int(n)} ${n === 1 ? one : many}`;
	const share = (a: number, of: number) => (of ? Math.min(100, (a / of) * 100) : 0);
	const sliceClass = ['bg-emerald-600', 'bg-amber-700', 'bg-rose-600', 'bg-stone-500'];
	const namedNote = (r: SiteRow, total: boolean) => {
		if (r.named === null) return null;
		const missing = r.namedOf - r.named;
		if (missing) return NO_NAMES[r.site as keyof typeof NO_NAMES] ?? `${int(missing)} with no name`;
		return total && r.namedOf < r.prints ? 'anonymous posts left out' : null;
	};
</script>

{#snippet q(tip: string)}
	<span class="ml-1 inline-grid size-3.5 cursor-help place-items-center rounded-full border border-stone-700 align-[1px] text-[9px] font-bold text-stone-500" title={tip}
		>?</span
	>
{/snippet}

{#snippet frac(a: number | null, of: number, note: string | null, na: string | undefined)}
	{#if a === null}
		<div class="text-stone-600">n/a</div>
		<div class="text-xs text-stone-600">{na}</div>
	{:else}
		{@const full = a >= of * 0.995}
		<div class="text-stone-100">{int(a)}<span class="text-xs text-stone-500">&nbsp;/ {int(of)}</span></div>
		<div class="mt-1 h-0.5 max-w-28 overflow-hidden rounded-full bg-stone-800">
			<div class="h-full rounded-full {full ? 'bg-emerald-600' : 'bg-amber-600'}" style="width: {share(a, of)}%"></div>
		</div>
		{#if note}<div class="mt-0.5 text-xs {full ? 'text-stone-500' : 'text-amber-300/80'}">{note}</div>{/if}
	{/if}
{/snippet}

{#snippet row(r: SiteRow, total: boolean)}
	{@const na = NOT_APPLICABLE[r.site as keyof typeof NOT_APPLICABLE]}
	<tr class="border-t align-top {total ? 'border-stone-700 bg-stone-950/40' : 'border-stone-800/70'}">
		<th scope="row" class="sticky left-0 bg-stone-950 py-2.5 pr-3 pl-3 text-left font-semibold whitespace-nowrap text-stone-100 sm:static sm:bg-transparent">{r.name}</th>
		<td class="px-2 py-2.5 text-base font-semibold text-stone-100">{int(r.prints)}</td>
		<td class="px-2 py-2.5 text-stone-200">{int(r.listed)}</td>
		<td class="px-2 py-2.5">{@render frac(r.analysed, r.prints, r.prints - r.analysed ? `${int(r.prints - r.analysed)} on an older one` : null, undefined)}</td>
		<td class="px-2 py-2.5">{@render frac(r.named, r.namedOf, namedNote(r, total), na?.author)}</td>
		<td class="px-2 py-2.5">{@render frac(r.shot, r.shotOf, r.shot !== null && r.shotOf > r.shot ? `${int(r.shotOf - r.shot)} with none` : null, na?.shot)}</td>
		<td class="px-2 py-2.5">
			<div class="text-stone-100">{int(r.render.rendered)}<span class="text-xs text-stone-500">&nbsp;/ {int(r.render.total)}</span></div>
			<div class="mt-1 flex h-1 max-w-32 gap-px overflow-hidden rounded-full bg-stone-800">
				{#each [r.render.rendered, r.render.none, r.render.failed, r.render.left] as n, i (i)}
					{#if n}<span class="block h-full {sliceClass[i]}" style="width: {share(n, r.render.total)}%"></span>{/if}
				{/each}
			</div>
			<div class="mt-0.5 text-xs text-stone-500">
				{#if r.render.none}<div>{int(r.render.none)} can’t be drawn</div>{/if}
				{#if r.render.failed}<div class="text-rose-300">{int(r.render.failed)} failed</div>{/if}
				{#if r.render.left}<div>{int(r.render.left)} waiting</div>{/if}
				{#if r.render.older}<div>{int(r.render.older)} before 2.0, not rendered</div>{/if}
			</div>
		</td>
		<td class="px-2 py-2.5"><div class="text-stone-100">{int(r.render.pages)}</div><div class="text-xs text-stone-500">{size(r.render.bytes)}</div></td>
		<td class="px-2 py-2.5">
			<div class="text-stone-100">{int(r.pulled)}</div>
			<div class="text-xs text-stone-500">
				{#if r.dupOther}<div>{plural(r.dupOther, 'duplicate', 'duplicates')} of another site’s print</div>{/if}
				{#if r.dupSame}<div>{plural(r.dupSame, 'duplicate', 'duplicates')} on the same site</div>{/if}
				{#if r.unreadable === null}<div title="No admission ledger for this stage on this machine">— unreadable</div>
				{:else if r.unreadable}<div class="text-amber-300/80">{int(r.unreadable)} unreadable</div>{/if}
			</div>
		</td>
	</tr>
{/snippet}

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

	<dl class="grid grid-cols-2 gap-3 lg:grid-cols-4">
		{#each cards as f (f.t)}
			<div class="{card} flex flex-col-reverse">
				<dt class="text-sm text-stone-400">
					{f.t}
					{#if f.sub}<span class="block text-xs text-stone-500">{f.sub}</span>{/if}
				</dt>
				<dd class="text-2xl font-semibold text-stone-100 tabular-nums">{f.n}</dd>
			</div>
		{/each}
	</dl>

	{#if table}
		<div class="overflow-x-auto rounded-lg border border-stone-800 bg-stone-900/50">
			<table class="w-full min-w-[1100px] table-fixed text-sm tabular-nums">
				<colgroup>
					<col class="w-40" />
					<col class="w-20" />
					<col class="w-24" />
					<col class="w-32" />
					<col class="w-32" />
					<col class="w-32" />
					<col class="w-36" />
					<col class="w-32" />
					<col class="w-48" />
				</colgroup>
				<thead class="bg-stone-950/40">
					<tr class="align-bottom">
						<th scope="col" class="px-3 py-2.5 text-left {label}">Source</th>
						{#each HEADS as h (h.t)}
							<th scope="col" class="px-2 py-2.5 text-left font-medium">
								<span class="whitespace-nowrap text-stone-200">{h.t}{@render q(h.tip)}</span>
								{#if h.sub}<span class="block text-xs font-normal text-stone-500">{h.sub}</span>{/if}
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each table.rows as r (r.site)}{@render row(r, false)}{/each}
					{@render row(table.total, true)}
				</tbody>
			</table>
		</div>
		<ul class="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-stone-400">
			{#each ['Rendered', 'Can’t be drawn', 'Failed', 'Waiting'] as l, i (l)}
				<li><span class="mr-1.5 inline-block size-2.5 rounded-sm align-[-1px] {sliceClass[i]}"></span>{l}</li>
			{/each}
			<li class="text-stone-500">“a / b”: a out of b prints, as each column says. Render columns come from this machine’s render queue.</li>
		</ul>
	{:else}
		<p class="{card} text-sm text-stone-400">Not counted by source yet: the next update (or Count again) counts them.</p>
	{/if}

	<section aria-labelledby="r2-title" class="space-y-2">
		<h3 id="r2-title" class={label}>R2 storage</h3>
		<div class="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
			<div class="overflow-x-auto rounded-lg border border-stone-800 bg-stone-900/50">
				<table class="w-full text-sm tabular-nums">
					<thead class="bg-stone-950/40">
						<tr class="align-bottom">
							<th scope="col" class="px-3 py-2.5 text-left {label}">Bucket</th>
							<th scope="col" class="px-3 py-2.5 text-right font-medium text-stone-200">Files</th>
							<th scope="col" class="px-3 py-2.5 text-right font-medium text-stone-200">Size</th>
							<th scope="col" class="px-3 py-2.5 text-right font-medium text-stone-200"
								>Est. cost a month{@render q(`Size × $${R2_STORAGE_PER_GB_MONTH} per GB-month, R2’s list price. R2’s free 10 GB is shared with the account’s other buckets, so it isn’t taken off.`)}</th
							>
						</tr>
					</thead>
					{#if r2}
						<tbody>
							{#each r2.buckets as b (b.name)}
								<tr class="border-t border-stone-800/70 align-top">
									<th scope="row" class="px-3 py-2 text-left font-normal">
										<span class="text-stone-100">{BUCKET_TEXT[b.kind].title}</span>
										<span class="hidden text-xs text-stone-500 sm:block">{BUCKET_TEXT[b.kind].holds}</span>
									</th>
									<td class="px-3 py-2 text-right whitespace-nowrap text-stone-200">{b.objects === null ? '—' : int(b.objects)}</td>
									<td class="px-3 py-2 text-right whitespace-nowrap text-stone-200">{b.bytes === null ? 'no reading' : size(b.bytes)}</td>
									<td class="px-3 py-2 text-right text-stone-200">{b.dollars === null ? '—' : `$${b.dollars.toFixed(2)}`}</td>
								</tr>
							{/each}
							<tr class="border-t border-stone-700 bg-stone-950/40 font-semibold text-stone-100">
								<th scope="row" class="px-3 py-2 text-left">All</th>
								<td class="px-3 py-2 text-right">{int(r2.objects)}</td>
								<td class="px-3 py-2 text-right whitespace-nowrap">{size(r2.bytes)}</td>
								<td class="px-3 py-2 text-right">${r2.dollars.toFixed(2)}</td>
							</tr>
						</tbody>
					{/if}
				</table>
				{#if !r2}
					<p class="px-3 py-3 text-sm text-stone-400">
						{r2Error ? `Unavailable: ${r2Error}` : 'Not read yet: the next update (or Count again) reads it.'}
					</p>
				{/if}
			</div>
			<div class="{card} space-y-2 text-xs text-stone-400">
				<p>From Cloudflare’s R2 analytics, for the whole site: the site’s own buckets only, not split by source.</p>
				<p>
					Sizes are object data plus metadata, as storage is billed, at each bucket’s latest reading in the last week{r2 && r2.missing
						? `; ${r2.missing} bucket${r2.missing === 1 ? '' : 's'} had none`
						: ''}.
				</p>
				<p>Cost at R2’s list price, ${R2_STORAGE_PER_GB_MONTH} per GB-month. The free 10 GB is shared with the account’s other buckets, so it isn’t taken off.</p>
				{#if figures?.r2}<p class="text-stone-500">Read {ago(now - figures.r2.at)}, with the figures.</p>{/if}
			</div>
		</div>
	</section>
</section>
