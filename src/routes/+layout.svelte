<script lang="ts">
	import './layout.css';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<title>Blueprint Atlas</title>
</svelte:head>

<div class="min-h-screen bg-stone-950 text-stone-200">
	<header class="border-b border-stone-800 bg-stone-900/80">
		<div class="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
			<a href="/" class="text-lg font-semibold tracking-tight text-amber-400">Blueprint Atlas</a>
		</div>
	</header>
	<main class="mx-auto max-w-7xl px-4 py-6">
		{@render children()}
	</main>
	<footer class="mx-auto max-w-7xl px-4 py-8 text-xs text-stone-500">
		Factorio is a trademark of Wube Software Ltd. Not affiliated with Wube Software or factorioprints.com. Prints are mirrored from
		<a class="underline" href="https://factorioprints.com">factorioprints.com</a> and credited to their authors.
	</footer>
</div>
