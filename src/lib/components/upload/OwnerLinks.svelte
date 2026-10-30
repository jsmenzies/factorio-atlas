<script lang="ts">
	/**
	 * "Edit your upload" on a print page, for its owner only. Print pages are cached and the same for
	 * everyone, so the page never knows who is looking: once it has drawn, a signed-in browser (the
	 * hint cookie, app.html) asks /me whether this print is its own upload.
	 */
	let { printId }: { printId: string } = $props();
	let owns = $state(false);

	$effect(() => {
		const id = printId;
		owns = false;
		if (!id.startsWith('up-') || document.documentElement.dataset.auth !== 'in') return;
		fetch(`/me?print=${encodeURIComponent(id)}`)
			.then((res) => (res.ok ? (res.json() as Promise<{ owns?: boolean }>) : null))
			.then((body) => {
				if (id === printId) owns = body?.owns === true;
			})
			.catch(() => {});
	});
</script>

{#if owns}
	<p class="rounded border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-sm text-stone-300">
		This is your upload. <a class="text-amber-300 underline" href="/uploads/{printId}">Edit or delete it</a>
	</p>
{/if}
