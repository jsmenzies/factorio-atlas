<script lang="ts">
	import Lightbox from '#lib/components/Lightbox.svelte';
	import type { Picture } from '#lib/screenshots.js';

	/**
	 * The author's screenshot, full screen: our "large" size (at most 2560 px) and a link to the
	 * original file (scaled down only when it is huge), or, while ours isn't there yet, Imgur's
	 * original (`imgur`: no Referer, size unknown, 0 × 0). `title` is plain text.
	 */
	let {
		large,
		full,
		title,
		imgur = false
	}: { large: Picture; full: Picture & { capped: boolean }; title: string; imgur?: boolean } = $props();

	let lightbox = $state<Lightbox>();
	export const open = () => lightbox?.open();
</script>

<Lightbox bind:this={lightbox} label="Screenshot of {title}">
	<img
		referrerpolicy={imgur ? 'no-referrer' : undefined}
		src={large.src}
		width={large.width || undefined}
		height={large.height || undefined}
		alt="Screenshot of {title}"
		loading="lazy"
		class="mx-auto block h-auto max-h-[calc(95vh-5.5rem)] w-auto max-w-[95vw] object-contain"
	/>
	<p class="border-t border-stone-800 px-3 py-2 text-right text-xs text-stone-400">
		<a
			href={full.src}
			target="_blank"
			rel={imgur ? 'noopener noreferrer' : 'noopener'}
			class="text-stone-300 underline decoration-stone-500 hover:text-amber-300">View original</a
		>
		{#if full.width && full.height}
			({full.width.toLocaleString('en-US')} × {full.height.toLocaleString('en-US')}{full.capped ? ', scaled down from a larger file' : ''})
		{/if}
	</p>
</Lightbox>
