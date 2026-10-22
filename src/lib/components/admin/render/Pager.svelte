<script lang="ts">
	import { page } from '$app/state';

	/** Newer/older links for one list on the page, kept in `?<param>=` so each list pages on its own. */
	let { param, current, pages, anchor, label }: { param: string; current: number; pages: number; anchor: string; label: string } = $props();

	const href = (n: number) => {
		const url = new URL(page.url.href);
		if (n <= 1) url.searchParams.delete(param);
		else url.searchParams.set(param, String(n));
		return `${url.pathname}${url.search}#${anchor}`;
	};
</script>

{#if pages > 1}
	<nav class="flex items-center gap-3 text-sm" aria-label={label}>
		{#if current > 1}<a href={href(current - 1)} class="text-amber-400 hover:text-amber-300">← Newer</a>{/if}
		<span class="text-stone-500">Page {current} of {pages}</span>
		{#if current < pages}<a href={href(current + 1)} class="text-amber-400 hover:text-amber-300">Older →</a>{/if}
	</nav>
{/if}
