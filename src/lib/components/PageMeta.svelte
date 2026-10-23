<script lang="ts">
	import { page } from '$app/state';

	/** The site's default link-preview card (static/og.png). */
	const CARD = { path: '/og.png', width: 1200, height: 630, alt: 'Blueprint Atlas: search Factorio blueprints with high-res renders' };
	const SITE = 'Blueprint Atlas';

	/**
	 * A page's title and the tags search engines and link previews read (Open Graph, Twitter cards).
	 * Only pages render it, never a layout, so no tag appears twice. `canonical` is a path (with its
	 * query, if it has one); the origin is the request's, so the code never names the domain.
	 * `noindex` keeps the page out of search results while crawlers still follow its links. `image`
	 * (an absolute URL) replaces the default card, e.g. a print's screenshot.
	 */
	let {
		title,
		description,
		canonical,
		noindex = false,
		image
	}: { title: string; description: string; canonical?: string; noindex?: boolean; image?: { url: string; alt: string } } = $props();

	const url = $derived(canonical === undefined ? page.url.href : `${page.url.origin}${canonical}`);
	// Previews show the site's name on their own.
	const shortTitle = $derived(title.replace(new RegExp(` · ${SITE}$`), ''));
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />
	{#if noindex}<meta name="robots" content="noindex, follow" />{/if}
	{#if canonical !== undefined}<link rel="canonical" href={url} />{/if}
	<meta property="og:site_name" content={SITE} />
	<meta property="og:type" content="website" />
	<meta property="og:title" content={shortTitle} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={url} />
	{#if image}
		<meta property="og:image" content={image.url} />
		<meta property="og:image:alt" content={image.alt} />
	{:else}
		<meta property="og:image" content="{page.url.origin}{CARD.path}" />
		<meta property="og:image:width" content={String(CARD.width)} />
		<meta property="og:image:height" content={String(CARD.height)} />
		<meta property="og:image:alt" content={CARD.alt} />
	{/if}
	<meta name="twitter:card" content="summary_large_image" />
</svelte:head>
