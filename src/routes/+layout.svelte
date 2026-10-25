<script lang="ts">
	import './layout.css';
	import RateToggle from '#lib/components/RateToggle.svelte';
	import { readRateUnit } from '#lib/rate-unit.svelte.js';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
	// After hydration, so tooltips switch to the visitor's unit instead of mismatching the server's HTML.
	$effect(() => readRateUnit());
</script>

<svelte:head>
	<title>Blueprint Atlas</title>
</svelte:head>

<!-- overflow-x-clip: the print page header's backdrop spans the window (w-screen) from inside main. -->
<div class="min-h-screen overflow-x-clip bg-stone-950 text-stone-200">
	<header class="border-b border-stone-800 bg-stone-900/80">
		<div class="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
			<a href="/" class="text-lg font-semibold tracking-tight text-amber-400">Blueprint Atlas</a>
			<div class="ml-auto"><RateToggle /></div>
			<a
				href="https://github.com/jsmenzies/factorio-atlas"
				class="text-stone-400 hover:text-amber-300"
				aria-label="Source code on GitHub"
				title="Source code on GitHub"
				><svg aria-hidden="true" viewBox="0 0 16 16" class="size-5" fill="currentColor"
					><path
						d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"
					/></svg
				></a
			>
		</div>
	</header>
	<main class="mx-auto max-w-7xl px-4 py-6">
		{@render children()}
	</main>
	<footer class="mx-auto max-w-7xl px-4 py-8 text-xs text-stone-500">
		Factorio is a trademark of Wube Software Ltd. Not affiliated with Wube Software or factorioprints.com. Prints are mirrored from
		<a class="underline" href="https://factorioprints.com">factorioprints.com</a> and credited to their authors. Screenshots are copies
		of the authors' Imgur uploads:
		<a class="underline" href="https://github.com/jsmenzies/factorio-atlas/issues/new?template=remove-screenshot.yml" rel="nofollow"
			>ask for one to be removed</a
		>.
	</footer>
</div>
