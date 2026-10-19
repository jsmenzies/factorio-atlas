<script lang="ts">
	import type { IconKind, IconSet } from '#lib/icons.js';

	let { icons, kind, name, label, size = 20 }: { icons: IconSet; kind: IconKind; name: string; label: string; size?: number } =
		$props();

	const cell = $derived(icons[kind][name]);
	const scale = $derived(size / icons.sheet.size);
</script>

{#if cell}
	<span
		role="img"
		aria-label={label}
		title={label}
		class="inline-block shrink-0 bg-no-repeat align-middle"
		style:width="{size}px"
		style:height="{size}px"
		style:background-image="url({icons.sheet.url})"
		style:background-size="{icons.sheet.width * scale}px {icons.sheet.height * scale}px"
		style:background-position="-{cell[0] * size}px -{cell[1] * size}px"
	></span>
{:else}
	<!-- No icon (modded or unknown): keep the slot so names still line up. -->
	<span aria-hidden="true" class="inline-block shrink-0 rounded bg-stone-800" style:width="{size}px" style:height="{size}px"></span>
{/if}
