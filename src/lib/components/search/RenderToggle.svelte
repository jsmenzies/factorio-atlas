<script lang="ts">
	/**
	 * The "Only prints with a render" switch beside the search box: a link to the current search
	 * with `render` toggled, so it works without JS. The icon matches the render badge on cards.
	 */
	let { on, href }: { on: boolean; href: string } = $props();
</script>

<a
	{href}
	role="switch"
	aria-checked={on}
	title="Only prints with a game render"
	class="flex shrink-0 items-center gap-2 rounded border px-3 py-2 text-sm whitespace-nowrap transition-colors {on
		? 'border-amber-500/70 bg-amber-500/10 text-amber-200'
		: 'border-stone-700 bg-stone-900 text-stone-300 hover:border-stone-500 hover:text-stone-100'}"
>
	<svg
		viewBox="0 0 24 24"
		class="size-4 {on ? 'text-amber-300' : 'text-stone-400'}"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
	>
		<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
		<path d="m3.3 7 8.7 5 8.7-5" />
		<path d="M12 22V12" />
	</svg>
	<span><span class="hidden sm:inline">Only prints with a render</span><span class="sm:hidden">Renders</span></span>
	<span aria-hidden="true" class="relative h-4 w-7 shrink-0 rounded-full transition-colors {on ? 'bg-amber-500/70' : 'bg-stone-700'}">
		<span class="absolute top-0.5 size-3 rounded-full bg-stone-100 transition-all {on ? 'left-3.5' : 'left-0.5'}"></span>
	</span>
</a>
