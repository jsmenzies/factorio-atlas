<script lang="ts">
	import BlueprintViewer from '#lib/components/BlueprintViewer.svelte';
	import type { RenderSidecar } from '#lib/viewer/game-render.js';
	import type { CompactPage } from '#lib/viewer/types.js';

	/**
	 * The viewer embedded in the print page. Its data (up to ~1 MB for a 12,000-entity page) is
	 * fetched after the page loads, so the rest of the page never waits for it.
	 */
	let { printId, path }: { printId: string; path: string } = $props();

	let data = $state.raw<{ page: CompactPage | null; render: RenderSidecar | null } | null>(null);
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
	{#if data?.page}
		{#key path}
			<BlueprintViewer page={data.page} render={data.render ? { sidecar: data.render, base: `/prints/${printId}/render` } : null} />
		{/key}
	{:else}
		<div class="grid h-full place-items-center bg-[radial-gradient(circle,rgb(68_64_60/0.6)_1px,transparent_1px)] bg-size-[14px_14px] text-sm text-stone-500">
			{failed ? 'Could not load this page.' : data ? 'Nothing to draw on this page.' : 'Loading blueprint…'}
		</div>
	{/if}
	<a
		href={fullScreen}
		class="absolute right-2 bottom-2 z-10 rounded bg-stone-900/90 px-2 py-1 text-xs text-stone-300 ring-1 ring-stone-700 hover:text-amber-300"
		>Full screen ⤢</a
	>
</div>
