<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import { iconUrl, type IconSet } from '#lib/icons.js';
	import { parseRichText } from '#lib/richtext.js';

	/** Factorio rich text (`Big Boy [item=space-science-pack]`) with its icons drawn inline. */
	let { text, icons, size = 20 }: { text: string; icons: IconSet; size?: number } = $props();

	const segments = $derived(parseRichText(text));
	const label = (name: string) => {
		const words = name.replace(/^signal-/, '').replaceAll('-', ' ');
		return words.charAt(0).toUpperCase() + words.slice(1);
	};
</script>

{#each segments as seg, i (i)}{#if seg.kind === 'text'}{seg.text}{:else if seg.icon && iconUrl(icons, seg.icon, seg.name)}<span
			class="mx-0.5 inline-block align-[-0.15em]"><Icon {icons} kind={seg.icon} name={seg.name} label={label(seg.name)} {size} /></span
		>{:else if seg.type === 'virtual-signal' && /^signal-[0-9A-Z]$/.test(seg.name)}<span
			class="mx-0.5 rounded bg-stone-800 px-1 font-mono text-[0.8em]"
			title={seg.name}>{seg.name.slice(-1)}</span
		>{:else}<span class="mx-0.5 rounded bg-stone-800 px-1 text-[0.8em] text-stone-300" title="{seg.type}: {seg.name}">{label(seg.name)}</span
		>{/if}{/each}
