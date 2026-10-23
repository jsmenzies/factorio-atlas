<script lang="ts">
	/** The cube that marks renders: the card badge, the "Only prints with a render" switch and its filter chip. */
	let { class: className = 'size-4' }: { class?: string } = $props();
</script>

<svg viewBox="0 0 24 24" class={className} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
	<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
	<path d="m3.3 7 8.7 5 8.7-5" />
	<path d="M12 22V12" />
</svg>
