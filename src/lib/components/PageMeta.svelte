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
	 * replaces the default card, e.g. a print's screenshot: `src` absolute or a path on this site,
	 * `width`/`height` when known (0: not known).
	 */
	let {
		title,
		description,
		canonical,
		noindex = false,
		image
	}: {
		title: string;
		description: string;
		canonical?: string;
		noindex?: boolean;
		image?: { src: string; width?: number; height?: number; alt: string };
	} = $props();

	const url = $derived(canonical === undefined ? page.url.href : `${page.url.origin}${canonical}`);
	// Previews show the site's name on their own.
	const shortTitle = $derived(title.replace(new RegExp(` · ${SITE}$`), ''));
	const imageUrl = $derived(image ? (image.src.startsWith('/') ? `${page.url.origin}${image.src}` : image.src) : null);
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
	{#if image && imageUrl}
		<meta property="og:image" content={imageUrl} />
		{#if image.width && image.height}
			<meta property="og:image:width" content={String(image.width)} />
			<meta property="og:image:height" content={String(image.height)} />
		{/if}
		<meta property="og:image:alt" content={image.alt} />
	{:else}
		<meta property="og:image" content="{page.url.origin}{CARD.path}" />
		<meta property="og:image:width" content={String(CARD.width)} />
		<meta property="og:image:height" content={String(CARD.height)} />
		<meta property="og:image:alt" content={CARD.alt} />
	{/if}
	<meta name="twitter:card" content="summary_large_image" />
</svelte:head>
