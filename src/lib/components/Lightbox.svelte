<script lang="ts">
	import type { Snippet } from 'svelte';

	let { label, children }: { label: string; children: Snippet } = $props();

	let dialog: HTMLDialogElement;

	export const open = () => dialog.showModal();
</script>

<!-- Native modal: Esc closes it and focus is trapped and restored for us. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
	bind:this={dialog}
	aria-label={label}
	class="m-auto max-h-[95vh] max-w-[95vw] overflow-hidden rounded-lg border border-stone-700 bg-stone-950 p-0 text-stone-200 backdrop:bg-black/80"
	onclick={(e) => e.target === dialog && dialog.close()}
>
	<div class="flex items-center justify-between gap-4 border-b border-stone-800 px-3 py-2 text-sm">
		<span class="truncate text-stone-400">{label}</span>
		<button class="rounded px-2 py-0.5 text-stone-300 hover:bg-stone-800" onclick={() => dialog.close()} aria-label="Close">✕</button>
	</div>
	{@render children()}
</dialog>
