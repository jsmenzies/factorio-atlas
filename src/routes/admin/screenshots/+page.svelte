<script lang="ts">
	import { enhance } from '$app/forms';
	import { plainText } from '#lib/richtext.js';
	import type { PageProps } from './$types';

	// Upload screenshots waiting for a decision (migration 0024 upload_images; src/lib/server/uploads/images.ts).
	let { data, form }: PageProps = $props();

	const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
	const size = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);
	const STATE: Record<string, string> = { live: 'on the site', processing: 'waiting for the sync', refused: 'refused', failed: 'failed' };
	let busy: string | null = $state(null);
</script>

<svelte:head><title>Screenshots · Admin</title></svelte:head>

<div class="space-y-8">
	<header class="space-y-1">
		<h1 class="text-xl font-semibold text-stone-100">Upload screenshots</h1>
		<p class="text-sm text-stone-400">
			Screenshots sent with uploads stay private until approved. Approve puts the screenshot on its prints; the next update makes its sizes,
			and until then the prints show no screenshot. Reject deletes it, and its uploader is told and can send another.
		</p>
	</header>

	{#if form && 'decided' in form && form.decided?.ok}
		{@const d = form.decided}
		<p class="rounded-lg border border-emerald-800 bg-emerald-950/30 p-4 text-sm text-stone-300" aria-live="polite">
			{#if d.status === 'approved'}
				Approved <span class="font-mono">{form.id}</span>: on {d.uploads} upload{d.uploads === 1 ? '' : 's'}, {d.shown} print{d.shown === 1 ? '' : 's'}
				ingested again. It shows once the next update has made its sizes.
			{:else}
				Rejected <span class="font-mono">{form.id}</span> and deleted it.
			{/if}
		</p>
	{:else if form && 'problem' in form}
		<p class="rounded-lg border border-red-800 bg-red-950/30 p-4 text-sm text-red-300" aria-live="polite">{form.problem}</p>
	{/if}

	<section class="space-y-4">
		<h2 class="font-medium text-stone-200">
			Waiting ({data.total}){data.total > data.images.length ? `, the oldest ${data.images.length} shown` : ''}
		</h2>
		{#if !data.images.length}<p class="text-sm text-stone-500">Nothing waiting.</p>{/if}
		{#each data.images as img (img.id)}
			<article class="grid gap-4 rounded-lg border border-stone-800 bg-stone-900/40 p-4 sm:grid-cols-[minmax(0,20rem)_1fr]">
				<a href="/admin/screenshots/{img.id}" target="_blank" rel="noopener" class="block overflow-hidden rounded border border-stone-800 bg-stone-950" title="Open full size">
					<img
						src="/admin/screenshots/{img.id}"
						alt="Uploaded screenshot {img.id}"
						width={img.size?.w}
						height={img.size?.h}
						loading="lazy"
						class="max-h-72 w-full object-contain"
					/>
				</a>
				<div class="min-w-0 space-y-3 text-sm">
					<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
						<dt class="text-stone-500">Prints</dt>
						<dd class="min-w-0 space-y-0.5">
							{#each img.uploads as u (u.print_id)}
								<p class="truncate">
									{#if u.state === 'live'}
										<a class="text-stone-100 hover:text-amber-300" href="/prints/{u.print_id}" target="_blank" rel="noopener">{plainText(u.title)}</a>
									{:else}
										<span class="text-stone-200">{plainText(u.title)}</span>
									{/if}
									<span class="text-xs text-stone-500">· {STATE[u.state] ?? u.state} · {u.print_id}</span>
								</p>
							{:else}
								<p class="text-stone-500">No upload uses it any more</p>
							{/each}
						</dd>
						<dt class="text-stone-500">Uploader</dt>
						<dd class="text-stone-200">{img.user_name ?? 'deleted account'}</dd>
						<dt class="text-stone-500">File</dt>
						<dd class="text-stone-300">
							{img.ext.toUpperCase()} · {size(img.bytes)}{img.size ? ` · ${img.size.w.toLocaleString('en')} × ${img.size.h.toLocaleString('en')}` : ''}
						</dd>
						<dt class="text-stone-500">Sent</dt>
						<dd class="text-stone-300">{when(img.created_at)} UTC</dd>
						<dt class="text-stone-500">Id</dt>
						<dd class="font-mono text-xs text-stone-500">{img.id}</dd>
					</dl>
					<form
						method="POST"
						class="flex flex-wrap items-center gap-3"
						use:enhance={({ action }) => {
							if (action.search.includes('reject') && !confirm('Reject this screenshot? It is deleted, and its uploader is told.')) {
								return ({ update }) => update({ reset: false });
							}
							busy = img.id;
							return async ({ update }) => {
								await update();
								busy = null;
							};
						}}
					>
						<input type="hidden" name="image" value={img.id} />
						<button formaction="?/approve" disabled={busy !== null} class="rounded bg-emerald-600 px-3 py-1 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
							>{busy === img.id ? 'Working…' : 'Approve'}</button
						>
						<button formaction="?/reject" disabled={busy !== null} class="rounded bg-stone-700 px-3 py-1 text-stone-100 hover:bg-stone-600 disabled:opacity-50"
							>Reject</button
						>
					</form>
				</div>
			</article>
		{/each}
	</section>
</div>
