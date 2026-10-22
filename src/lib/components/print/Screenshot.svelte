<script lang="ts">
	import Lightbox from '#lib/components/Lightbox.svelte';
	import { imgurUrl } from '#lib/format.js';

	/** The author's screenshot (Imgur), opening full size in a lightbox. `title` is plain text. */
	let { id, type, title }: { id: string; type: string | null; title: string } = $props();

	let lightbox = $state<Lightbox>();
</script>

<button
	onclick={() => lightbox?.open()}
	class="group relative block aspect-video w-full overflow-hidden rounded-lg border border-stone-800 bg-stone-900"
	aria-label="Expand the author's screenshot"
>
	<img
		referrerpolicy="no-referrer"
		src={imgurUrl(id, type, 'large')}
		alt="Screenshot of {title}"
		class="h-full w-full object-cover transition group-hover:scale-105"
		loading="lazy"
	/>
	<span class="absolute bottom-2 left-2 rounded bg-stone-950/80 px-2 py-0.5 text-xs text-stone-300">Author's screenshot ⤢</span>
</button>
<Lightbox bind:this={lightbox} label="Screenshot of {title}">
	<img
		referrerpolicy="no-referrer"
		src={imgurUrl(id, type, 'original')}
		alt="Screenshot of {title}"
		class="mx-auto block max-h-[calc(95vh-3rem)] max-w-[95vw] object-contain"
	/>
</Lightbox>
