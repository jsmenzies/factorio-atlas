<script lang="ts">
	/**
	 * The "Only prints with a render" switch beside the search box: a link to the current search
	 * with `render` toggled, so it works without JS. Sits inside the search bar's right end as a
	 * small chip with an amber outline: cube, "Renders", switch; the full wording is its accessible
	 * name and tooltip. The cube matches the render badge on cards.
	 */
	import RenderIcon from '#lib/components/RenderIcon.svelte';
	import { searchRel } from '#lib/search-seo.js';

	let { on, href }: { on: boolean; href: string } = $props();
</script>

<a
	{href}
	rel={searchRel(href)}
	role="switch"
	aria-checked={on}
	aria-label="Only prints with a render"
	title="Only prints with a game render"
	class="flex shrink-0 items-center gap-1.5 rounded-sm border px-2.5 py-1 text-xs whitespace-nowrap transition-colors {on
		? 'border-amber-500 bg-amber-500/15 text-amber-200'
		: 'border-amber-500/50 bg-stone-900 text-stone-300 hover:bg-stone-800 hover:text-stone-100'}"
>
	<RenderIcon class="size-3.5 {on ? 'text-amber-300' : 'text-stone-400'}" />
	<span>Renders</span>
	<span aria-hidden="true" class="relative h-3.5 w-6 shrink-0 rounded-full transition-colors {on ? 'bg-amber-500/70' : 'bg-stone-700'}">
		<span class="absolute top-0.5 size-2.5 rounded-full bg-stone-100 transition-all {on ? 'left-3' : 'left-0.5'}"></span>
	</span>
</a>
