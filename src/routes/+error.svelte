<script lang="ts">
	import { page } from '$app/state';
	import PageMeta from '#lib/components/PageMeta.svelte';
	import { GONE } from '#lib/gone.js';
	import { ownSource, siteUrl, SOURCE_SITES } from '#lib/sources.js';

	/**
	 * Every error, in the site's look and with its real status code. A print we don't have may be
	 * newer than our last import, so it links to the same print on the site its id names (#lib/sources.ts;
	 * not an upload's, which is only here). A print taken down on request, or an upload its author deleted,
	 * answers 410 (told apart by the message, lib/gone.ts) and links only back to search, as does anything
	 * else.
	 */
	const original = $derived.by(() => {
		const id = page.status === 404 ? /^\/prints\/([^/]+)\/?$/.exec(page.url.pathname)?.[1] : undefined;
		const own = id ? ownSource(id) : null;
		const url = own ? siteUrl(own.site, own.site_id) : null;
		return own && url ? { name: SOURCE_SITES[own.site].name, url } : undefined;
	});
	const removed = $derived(page.status === 410);
	const deleted = $derived(removed && page.error?.message === GONE.deleted);
	const serverError = $derived(page.status >= 500);
	// Over the rate limit (lib/server/rate-limit.ts); seen here when it hits an in-app navigation.
	const tooMany = $derived(page.status === 429);
	const heading = $derived(
		original
			? 'This print isn’t on Blueprint Atlas yet'
			: deleted
				? 'This blueprint was deleted'
				: removed
					? 'This print was removed'
				: serverError
				? 'Something went wrong on our side'
				: tooMany
					? 'Too many requests'
					: 'Page not found'
	);
</script>

<PageMeta
	title="{serverError || tooMany ? 'Error' : deleted ? 'Deleted' : removed ? 'Removed' : 'Not found'} · Blueprint Atlas"
	description="{heading}. Search Factorio blueprints by what they make, with high-res renders."
	noindex
/>

<div class="mx-auto max-w-xl space-y-4 py-16 text-center">
	<p class="text-sm font-medium text-amber-400">{page.status}</p>
	<h1 class="text-2xl font-semibold text-stone-100">{heading}</h1>
	{#if original}
		<p class="text-stone-400">
			It may be newer than our last copy from {original.name}, or it was removed. The original may still be there.
		</p>
	{:else if deleted}
		<p class="text-stone-400">Its author deleted it from Blueprint Atlas.</p>
	{:else if removed}
		<p class="text-stone-400">It was taken down at the request of its author or owner.</p>
	{:else if serverError}
		<p class="text-stone-400">Try again in a moment.</p>
	{:else if tooMany}
		<p class="text-stone-400">Please wait a minute, then try again.</p>
	{:else}
		<p class="text-stone-400">The link may be old, or the address mistyped.</p>
	{/if}
	<div class="flex flex-wrap justify-center gap-3 pt-2 text-sm">
		{#if original}
			<a class="rounded bg-amber-500/15 px-3 py-1.5 text-amber-300 hover:bg-amber-500/25" href={original.url} rel="external"
				>View it on {original.name}</a
			>
		{:else if serverError || tooMany}
			<a class="rounded bg-amber-500/15 px-3 py-1.5 text-amber-300 hover:bg-amber-500/25" href={page.url.href} data-sveltekit-reload>Reload</a>
		{/if}
		<a class="rounded bg-stone-800 px-3 py-1.5 text-stone-200 hover:bg-stone-700" href="/">Search blueprints</a>
	</div>
</div>
