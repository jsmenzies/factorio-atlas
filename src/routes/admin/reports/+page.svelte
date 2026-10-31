<script lang="ts">
	import { enhance } from '$app/forms';
	import { PURGE_ONLY, REMOVAL_REASONS, isRemovalReason } from '#lib/reports.js';
	import { plainText } from '#lib/richtext.js';
	import type { PageProps } from './$types';

	// Removal requests (migration 0021): approve takes the print down at once (src/lib/server/takedown.ts).
	let { data, form }: PageProps = $props();

	const reasonLabel = (r: string) => (isRemovalReason(r) ? REMOVAL_REASONS[r] : r);
	const when = (ms: number | null) => (ms === null ? '' : new Date(ms).toISOString().slice(0, 16).replace('T', ' '));
	let busy: string | null = $state(null);

	/** What a not-yet-applied takedown still has to purge (the report's `pending_purge`). */
	const pendingOf = (s: string | null): { prefixes: string[]; urls: string[] } => {
		try {
			const p = JSON.parse(s ?? '');
			return { prefixes: p.prefixes ?? [], urls: p.urls ?? [] };
		} catch {
			return { prefixes: [], urls: [] };
		}
	};
	/** Decided rows with the first unapplied approval of each print marked, so its actions show once. */
	const decidedRows = $derived.by(() => {
		const seen = new Set<string>();
		return data.decided.map((r) => {
			const first = r.status === 'approved' && r.applied_at === null && r.kind === 'removal' && !seen.has(r.subject_id);
			if (first) seen.add(r.subject_id);
			return { r, unfinished: first };
		});
	});
	/** Whether a print's requests asked about the screenshot, so a retry takes it down too. */
	const aboutScreenshot = (printId: string) => data.decided.some((d) => d.subject_id === printId && d.reason === 'screenshot');
</script>

<svelte:head><title>Reports · Admin</title></svelte:head>

<div class="space-y-8">
	<header class="space-y-1">
		<h1 class="text-xl font-semibold text-stone-100">Removal requests</h1>
		<p class="text-sm text-stone-400">
			Approve deletes the print, its analysis, renders, thumbnails and (unless another print shares it) its screenshot, and blocks it from every
			future import. Reject keeps it. Each print's open requests are decided together.
		</p>
		{#if !data.purgeOn}
			<p class="text-sm text-amber-300">
				No edge-cache purge on this stage (CACHE_PURGE_TOKEN): each takedown lists what to purge by hand.
			</p>
		{/if}
	</header>

	{#if form && 'takedown' in form && form.takedown}
		{@const t = form.takedown}
		<section class="space-y-2 rounded-lg border border-emerald-800 bg-emerald-950/30 p-4 text-sm text-stone-300" aria-live="polite">
			<p class="font-medium text-emerald-300">Taken down: {form.printId}</p>
			<p>
				{t.d1Rows} D1 rows, {t.rawObjects} RAW objects, {t.renderObjects} render files, screenshot {t.screenshot}{t.screenshot === 'removed'
					? ` (${t.screenshotObjects} files)`
					: ''}.
			</p>
			{#if t.purged}
				<p>Edge cache purged.</p>
			{:else if t.purge.prefixes.length || t.purge.urls.length}
				<p class="text-amber-300">
					{t.purgeError ? `Purge failed: ${t.purgeError}` : 'No purge token on this stage.'} Purge these in the dashboard (Caching → Configuration
					→ Custom Purge):
				</p>
				<ul class="list-disc pl-5 font-mono text-xs break-all text-stone-400">
					{#each t.purge.prefixes as p (p)}<li>prefix {p}</li>{/each}
					{#each t.purge.urls as u (u)}<li>{u}</li>{/each}
				</ul>
			{/if}
		</section>
	{:else if form && 'error' in form}
		<p class="rounded-lg border border-red-800 bg-red-950/30 p-4 text-sm text-red-300" aria-live="polite">{form.error}</p>
	{:else if form && 'marked' in form}
		<p class="text-sm text-stone-400" aria-live="polite">Marked {form.marked} request(s) for {form.printId} as purged by hand.</p>
	{:else if form && 'decided' in form}
		<p class="text-sm text-stone-400" aria-live="polite">Rejected {form.decided} request(s) for {form.printId}.</p>
	{/if}

	<section class="space-y-4">
		<h2 class="font-medium text-stone-200">Open ({data.open.length})</h2>
		{#if !data.open.length}<p class="text-sm text-stone-500">Nothing waiting.</p>{/if}
		{#each data.open as e (`${e.subjectKind}:${e.subjectId}`)}
			<article class="space-y-3 rounded-lg border border-stone-800 bg-stone-900/40 p-4">
				<div class="flex flex-wrap items-baseline justify-between gap-2">
					<h3 class="font-medium text-stone-100">
						{#if e.print}
							<a class="hover:text-amber-300" href="/prints/{e.printId}" target="_blank" rel="noopener">{plainText(e.print.title)}</a>
							<span class="text-sm font-normal text-stone-400">by {e.print.author_name ?? 'unknown'} · {e.print.favorites} favourites</span>
						{:else}
							{e.subjectId} <span class="text-sm font-normal text-stone-500">(not on the site any more)</span>
						{/if}
					</h3>
					<span class="font-mono text-xs text-stone-500">{e.subjectKind === 'print' ? '' : `${e.subjectKind} `}{e.subjectId}</span>
				</div>
				<ul class="space-y-2 text-sm">
					{#each e.requests as r (r.id)}
						<li class="rounded border border-stone-800 p-2">
							<p class="text-stone-200">{reasonLabel(r.reason)} <span class="text-xs text-stone-500">· {when(r.created_at)}</span></p>
							{#if r.details}<p class="whitespace-pre-line text-stone-400">{r.details}</p>{/if}
							{#if r.contact}<p class="text-xs text-stone-500">Contact: {r.contact}</p>{/if}
						</li>
					{/each}
				</ul>
				<form
					method="POST"
					class="flex flex-wrap items-center gap-3 text-sm"
					use:enhance={({ action }) => {
						if (action.search.includes('approve') && !confirm(`Take down ${e.print ? plainText(e.print.title) : e.subjectId}? This deletes it.`)) {
							return ({ update }) => update({ reset: false });
						}
						busy = e.subjectId;
						return async ({ update }) => {
							await update();
							busy = null;
						};
					}}
				>
					<input type="hidden" name="print" value={e.subjectId} />
					<input
						name="note"
						placeholder="Note (optional)"
						class="min-w-48 flex-1 rounded border border-stone-700 bg-stone-900 px-2 py-1 text-stone-100 focus:border-amber-500 focus:outline-none"
					/>
					{#if e.copies.length}
						<fieldset class="w-full space-y-1 rounded border border-stone-800 p-2">
							<legend class="px-1 text-xs text-stone-400">Identical prints (same blueprint, 50+ entities): ticked to go with it, untick any to keep</legend>
							{#each e.copies as c (c.id)}
								<label class="flex items-baseline gap-2 text-stone-300">
									<input type="checkbox" name="copy" value={c.id} checked class="accent-amber-500" />
									<a class="hover:text-amber-300" href="/prints/{c.id}" target="_blank" rel="noopener">{plainText(c.title)}</a>
									<span class="text-xs text-stone-500">by {c.author_name ?? 'unknown'}{c.sameAuthor ? ' (same author)' : ''} · {c.id}</span>
								</label>
							{/each}
						</fieldset>
					{/if}
					<label class="flex items-center gap-1.5 text-stone-400" title="Delete the screenshot even if other prints use the same image">
						<input type="checkbox" name="screenshot" checked={e.requests.some((r) => r.reason === 'screenshot')} class="accent-amber-500" />
						Screenshot even if shared
					</label>
					<button formaction="?/approve" disabled={busy !== null} class="rounded bg-red-600 px-3 py-1 font-medium text-white hover:bg-red-500 disabled:opacity-50"
						>{busy === e.subjectId ? 'Working…' : 'Approve and take down'}</button
					>
					<button formaction="?/reject" disabled={busy !== null} class="rounded bg-stone-700 px-3 py-1 text-stone-100 hover:bg-stone-600 disabled:opacity-50"
						>Reject</button
					>
				</form>
			</article>
		{/each}
	</section>

	<section class="space-y-2">
		<h2 class="font-medium text-stone-200">Decided</h2>
		{#if !data.decided.length}<p class="text-sm text-stone-500">None yet.</p>{/if}
		<table class="w-full text-left text-sm">
			<tbody>
				{#each decidedRows as { r, unfinished } (r.id)}
					<tr class="border-t border-stone-800 align-top">
						<td class="py-1.5 pr-3 font-mono text-xs text-stone-400">{r.subject_kind === 'print' ? '' : `${r.subject_kind} `}{r.subject_id}</td>
						<td class="py-1.5 pr-3 {r.status === 'approved' ? 'text-red-300' : 'text-stone-300'}">{r.status}</td>
						<td class="py-1.5 pr-3 text-stone-400">{reasonLabel(r.reason)}{r.note ? ` · ${r.note}` : ''}</td>
						<td class="py-1.5 pr-3 text-xs text-stone-500">{when(r.decided_at)} · {r.decided_by}</td>
						<td class="py-1.5 text-right">
							{#if unfinished}
								{@const pending = pendingOf(r.pending_purge)}
								<div class="space-y-1 text-left text-xs">
									{#if r.apply_error}<p class="text-amber-300">{r.apply_error}</p>{/if}
									{#if pending.prefixes.length || pending.urls.length}
										<details class="text-stone-400">
											<summary>Still to purge ({pending.prefixes.length + pending.urls.length})</summary>
											<ul class="list-disc pl-5 font-mono break-all">
												{#each pending.prefixes as p (p)}<li>prefix {p}</li>{/each}
												{#each pending.urls as u (u)}<li>{u}</li>{/each}
											</ul>
										</details>
									{/if}
									<form method="POST" action="?/retry" class="flex flex-wrap items-center justify-end gap-2" use:enhance>
										<input type="hidden" name="print" value={r.subject_id} />
										<label class="flex items-center gap-1 text-stone-400" title="Delete the screenshot even if other prints use the same image">
											<input type="checkbox" name="screenshot" checked={aboutScreenshot(r.subject_id)} class="accent-amber-500" />
											Screenshot even if shared
										</label>
										<button class="text-amber-400 hover:text-amber-300">Not finished: run takedown again</button>
									</form>
									{#if r.apply_error?.startsWith(PURGE_ONLY)}
										<form method="POST" action="?/purged" class="text-right" use:enhance>
											<input type="hidden" name="print" value={r.subject_id} />
											<button class="text-stone-400 hover:text-stone-200">I purged these by hand</button>
										</form>
									{/if}
								</div>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>
</div>
