<script lang="ts">
	let { stage }: { stage: string } = $props();

	const style = $derived(stage === 'prod' ? 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30' : 'bg-stone-800 text-stone-300');
</script>

<span class="rounded px-1.5 py-0.5 font-mono text-xs whitespace-nowrap {style}">{stage}</span>
