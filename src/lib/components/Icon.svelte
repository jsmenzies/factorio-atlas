<script lang="ts">
	import { iconUrl, signalIcon, type IconKind, type IconSet } from '#lib/icons.js';

	/** The one place game icons are drawn. Pass a `signal` ("fluid:water"), or a `kind` and `name`. */
	let {
		icons,
		kind = 'item',
		name = '',
		signal,
		label,
		size = 20
	}: { icons: IconSet; kind?: IconKind; name?: string; signal?: string; label: string; size?: number } = $props();

	const target = $derived(signal ? signalIcon(signal) : { kind, name });
	const src = $derived(iconUrl(icons, target.kind, target.name));
	/** A file that failed to load (not uploaded yet): show the blank slot instead of a broken image. */
	let failed = $state<string | null>(null);
</script>

{#if src && failed !== src}
	<img
		{src}
		alt={label}
		title={label || undefined}
		width={size}
		height={size}
		loading="lazy"
		decoding="async"
		draggable="false"
		class="inline-block shrink-0 align-middle"
		style:width="{size}px"
		style:height="{size}px"
		onerror={() => (failed = src)}
	/>
{:else}
	<!-- No icon (modded or unknown): keep the slot so names still line up. -->
	<span aria-hidden="true" class="inline-block shrink-0 rounded bg-stone-800" style:width="{size}px" style:height="{size}px"></span>
{/if}
