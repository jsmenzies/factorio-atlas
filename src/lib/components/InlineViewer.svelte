<script lang="ts">
	import BlueprintViewer from '#lib/components/BlueprintViewer.svelte';
	import type { RenderSidecar } from '#lib/viewer/game-render.js';
	import type { CompactPage, TooltipData } from '#lib/viewer/types.js';

	/**
	 * The viewer embedded in the print page, for pages that have a game render. Its data (up to
	 * ~1 MB for a 12,000-entity page) is fetched after the page loads, so the rest of the page
	 * never waits for it.
	 */
	let { printId, path }: { printId: string; path: string } = $props();

	let data = $state.raw<{ page: CompactPage | null; render: RenderSidecar | null; base: string; tooltip: TooltipData | null } | null>(null);
	let failed = $state(false);

	$effect(() => {
		const controller = new AbortController();
		data = null;
		failed = false;
		fetch(`/prints/${printId}/viewer?page=${encodeURIComponent(path)}`, { signal: controller.signal })
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
			.then((d) => (data = d as typeof data))
			.catch((e: unknown) => {
				if (!controller.signal.aborted) failed = !!e;
			});
		return () => controller.abort();
	});

	const fullScreen = $derived(`/prints/${printId}/render?page=${encodeURIComponent(path)}`);
</script>

<div class="relative h-[28rem] overflow-hidden rounded-lg border border-stone-800 bg-stone-950">
	{#if data?.page && data.render}
		{#key path}
			<!-- A viewer that throws (bad page data, a tooltip bug) loses only itself, not the print page. -->
			<svelte:boundary onerror={(e) => console.error('viewer failed:', e)}>
				<BlueprintViewer page={data.page} render={{ sidecar: data.render, base: data.base }} tooltip={data.tooltip} />
				{#snippet failed()}
					<div class="grid h-full place-items-center text-sm text-stone-500">Could not show this render.</div>
				{/snippet}
			</svelte:boundary>
		{/key}
	{:else}
		<div class="grid h-full place-items-center text-sm text-stone-500">
			{failed ? 'Could not load this page.' : data ? 'No render for this page.' : 'Loading render…'}
		</div>
	{/if}
	<a
		href={fullScreen}
		class="absolute right-2 bottom-2 z-10 rounded bg-stone-900/90 px-2 py-1 text-xs text-stone-300 ring-1 ring-stone-700 hover:text-amber-300"
		>Full screen ⤢</a
	>
</div>
