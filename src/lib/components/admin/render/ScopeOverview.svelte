<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { PIPELINE_DEP } from '../live.svelte.js';
	import type { RenderScopes, ScopeFigures } from '#lib/server/admin/render-scope.js';
	import { ago, int, percent } from '../metrics.js';

	/**
	 * What the renders cover: prints with a 2.0+ page, the top-N favourites (pre-2.0 pages drawn too)
	 * and both, by state. Under `vite dev` (`controls`), buttons refresh the top list, check the clone
	 * for changed records and pull it, through the dev-only plugin (scripts/render/dev-plugin.ts).
	 */
	let { scopes, now, controls, live }: { scopes: RenderScopes; now: number; controls: boolean; live: boolean } = $props();

	// The stored list's N, until the user types another.
	let n = $state<number | null>(null);
	const topN = $derived(n ?? scopes.favorites?.n ?? 1000);
	let busy = $state<'top' | 'check' | 'pull' | null>(null);
	let note = $state<string | null>(null);
	let error = $state<string | null>(null);

	const act = async (kind: 'top' | 'check' | 'pull') => {
		busy = kind;
		error = null;
		note = null;
		try {
			const res = await fetch(`/admin/render/__control/${kind}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(kind === 'top' ? { n: topN } : {})
			});
			const out = (await res.json()) as { ok?: boolean; error?: string; output?: string; result?: Record<string, number | string> };
			if (!res.ok || !out.ok) {
				error = out.error ?? `HTTP ${res.status}`;
				return;
			}
			const r = out.result;
			note =
				kind === 'top' && r
					? `Top ${int(Number(r.n))} of ${int(Number(r.prints))} prints recomputed in ${int(Number(r.ms))} ms (at least ${int(Number(r.cutoff))} favourites).`
					: kind === 'check' && r
						? `${int(Number(r.compared))} prints compared in ${int(Number(r.ms))} ms: ${int(Number(r.changed))} changed, ${int(Number(r.gone))} gone, ${int(Number(r.unseen))} never looked at.`
						: (out.output ?? 'Done.');
			await invalidate(PIPELINE_DEP);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = null;
		}
	};

	const ROWS: { key: keyof ScopeFigures; label: string; hint: string; color?: string }[] = [
		{ key: 'rendered', label: 'Rendered', hint: 'every drawable page done', color: 'text-emerald-300' },
		{ key: 'uploaded', label: 'Uploaded to prod', hint: 'rendered, every page up at its current version', color: 'text-sky-300' },
		{ key: 'left', label: 'Left to render', hint: 'pages pending, or not queued yet', color: 'text-stone-200' },
		{ key: 'none', label: 'Not drawable', hint: 'every page modded, empty or undecodable', color: 'text-amber-300' },
		{ key: 'failed', label: 'Failed', hint: 'a page out of attempts, or the record is missing', color: 'text-rose-300' },
		{ key: 'updated', label: 'Updated since looked at', hint: 'record changed at the last check: the next batch looks again', color: 'text-violet-300' }
	];
	const topLabel = $derived(scopes.favorites ? `Top ${int(scopes.favorites.n)} favourites` : 'Top favourites');
	const COLS = $derived([
		{ label: '2.0+ prints', f: scopes.modern },
		{ label: topLabel, f: scopes.top },
		{ label: 'Both', f: scopes.union }
	]);

	const card = 'rounded-lg border border-stone-800 bg-stone-900/50 p-4';
	const button = 'rounded border px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';
	const field = 'rounded border border-stone-700 bg-stone-950 px-2 py-1 text-sm text-stone-100';
</script>

<section class="space-y-3" aria-labelledby="coverage">
	<div class="flex flex-wrap items-baseline justify-between gap-2">
		<h2 id="coverage" class="text-lg font-semibold text-stone-100">
			Coverage <span class="font-normal text-stone-500">· prints by scope</span>
		</h2>
	</div>
	<div class="{card} space-y-3">
		<div class="overflow-x-auto">
			<table class="w-full min-w-[32rem] text-sm">
				<thead>
					<tr class="text-left text-xs tracking-wide text-stone-500 uppercase">
						<th class="py-1 pr-4 font-medium">Prints</th>
						{#each COLS as c (c.label)}<th class="py-1 pr-4 text-right font-medium">{c.label}</th>{/each}
					</tr>
				</thead>
				<tbody class="divide-y divide-stone-800/70">
					<tr>
						<td class="py-1.5 pr-4 text-stone-200">In scope</td>
						{#each COLS as c (c.label)}<td class="py-1.5 pr-4 text-right text-stone-100 tabular-nums">{int(c.f.total)}</td>{/each}
					</tr>
					{#each ROWS as r (r.key)}
						<tr>
							<td class="py-1.5 pr-4">
								<span class={r.color}>{r.label}</span>
								<span class="block text-xs text-stone-500">{r.hint}</span>
							</td>
							{#each COLS as c (c.label)}
								<td class="py-1.5 pr-4 text-right tabular-nums {c.f[r.key] ? 'text-stone-100' : 'text-stone-600'}">
									{int(c.f[r.key])}
									{#if c.f[r.key] && c.f.total}<span class="block text-xs text-stone-500">{percent(c.f[r.key], c.f.total)}</span>{/if}
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<p class="text-xs text-stone-500">
			{#if scopes.favorites}
				{topLabel}: {int(scopes.top.modern)} with a 2.0+ page, {int(scopes.top.preModern)} saved only before 2.0 (drawn too){scopes.top.unseen
					? `, ${int(scopes.top.unseen)} not looked at yet`
					: ''}. At least {int(scopes.favorites.cutoff)} favourites; from {scopes.favorites.source}, of {int(scopes.favorites.prints)} prints,
				refreshed {ago(now - scopes.favorites.refreshed_at)}.
				{#if scopes.former}{int(scopes.former)} earlier favourites, out of the top {int(scopes.favorites.n)} now, keep their renders.{/if}
			{:else}
				No top list yet: refresh it below, or run <code class="text-stone-300">bun run render --top N</code>.
			{/if}
		</p>
		<p class="text-xs text-stone-500">
			{#if scopes.check}
				Last check {ago(now - scopes.check.checked_at)} against {scopes.check.source}: {int(scopes.check.compared)} prints compared,
				{int(scopes.check.changed)} changed and {int(scopes.check.gone)} gone since a run looked at them, {int(scopes.check.unseen)} in the clone never
				looked at. A batch (<code class="text-stone-300">--next</code>) looks at changed prints again and draws only the pages that changed.
			{:else}
				The clone hasn't been checked for changed records yet.
			{/if}
		</p>

		{#if controls}
			<div class="flex flex-wrap items-end gap-3 border-t border-stone-800 pt-3">
				<label class="space-y-1 text-sm text-stone-300">
					<span class="block text-xs text-stone-500">Top N</span>
					<input type="number" min="1" max="100000" step="1" value={topN} oninput={(e) => (n = Number(e.currentTarget.value) || null)} class="{field} w-28 tabular-nums" />
				</label>
				<button type="button" disabled={!!busy} onclick={() => act('top')} class="{button} border-amber-600/70 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30">
					{busy === 'top' ? 'Refreshing…' : `Refresh top ${int(topN)}`}
				</button>
				<button
					type="button"
					disabled={!!busy}
					onclick={() => act('check')}
					class="{button} border-stone-700 bg-stone-800 text-stone-100 hover:bg-stone-700"
					title="Compare each print's record file in the clone with the size and mtime a run recorded"
				>
					{busy === 'check' ? 'Checking…' : 'Check for updated prints'}
				</button>
				<button
					type="button"
					disabled={!!busy || live}
					onclick={() => act('pull')}
					class="{button} border-stone-700 bg-stone-800 text-stone-100 hover:bg-stone-700"
					title={live ? 'Stop the run first: it reads records from the clone' : 'git pull --ff-only in the mirror clone; then check for updated prints'}
				>
					{busy === 'pull' ? 'Pulling…' : 'Pull the clone'}
				</button>
			</div>
			{#if note}<p class="text-sm text-sky-300" role="status">{note}</p>{/if}
			{#if error}<pre class="text-sm whitespace-pre-wrap text-rose-300" role="alert">{error}</pre>{/if}
		{/if}
	</div>
</section>
