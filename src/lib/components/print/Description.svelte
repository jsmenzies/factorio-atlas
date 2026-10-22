<script lang="ts">
	/**
	 * The author's description, already sanitised server-side by renderDescription
	 * (#lib/server/markdown.js), so safe for {@html}. Long ones (often changelogs) are clamped so
	 * the cards below stay in reach.
	 */
	let { html, long }: { html: string; long: boolean } = $props();

	let showFull = $state(false);
	// Styles for the sanitised Markdown: p, h3–h6, lists, quotes, code, links, images.
	const prose = [
		'space-y-2 text-sm leading-relaxed break-words text-stone-300',
		'[&_a]:text-amber-400 [&_a]:underline [&_a]:decoration-amber-400/40 [&_a:hover]:text-amber-300',
		'[&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-stone-100 [&_h4]:font-semibold [&_h4]:text-stone-100',
		'[&_h5]:font-semibold [&_h5]:text-stone-200 [&_h6]:font-semibold [&_h6]:text-stone-200 [&_strong]:text-stone-100',
		'[&_ul]:list-disc [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:pl-5 [&_li]:my-0.5 [&_li]:marker:text-stone-500',
		'[&_blockquote]:border-l-2 [&_blockquote]:border-stone-700 [&_blockquote]:pl-3 [&_blockquote]:text-stone-400',
		'[&_code]:rounded [&_code]:bg-stone-800 [&_code]:px-1 [&_code]:text-[0.85em] [&_pre]:overflow-x-auto [&_pre]:rounded',
		'[&_pre]:bg-stone-900 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_hr]:border-stone-800',
		'[&_img]:my-2 [&_img]:h-auto [&_img]:max-h-[32rem] [&_img]:max-w-full [&_img]:rounded'
	].join(' ');
</script>

<section>
	<h2 class="mb-2 font-semibold">Description</h2>
	<div class="{prose} {long && !showFull ? 'line-clamp-12' : ''}">
		{@html html}
	</div>
	{#if long}
		<button class="mt-1 text-sm text-amber-400 hover:text-amber-300" onclick={() => (showFull = !showFull)}>
			{showFull ? 'Show less' : 'Show full description'}
		</button>
	{/if}
</section>
