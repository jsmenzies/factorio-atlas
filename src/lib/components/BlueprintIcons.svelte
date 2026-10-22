<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import { iconUrl, signalIcon, type IconSet } from '#lib/icons.js';
	import { signalName } from '#lib/format.js';

	/**
	 * A blueprint's or book's own icons (the 1–4 signals the author picked), laid out the way
	 * the game draws them: one fills the badge, two sit side by side, three or four make a 2×2
	 * grid. Virtual signals without an icon are drawn: digits, letters and colours.
	 */
	let {
		icons,
		signals,
		kind = 'blueprint',
		size = 40
	}: { icons: IconSet; signals: string[]; kind?: string; size?: number } = $props();

	const shown = $derived(signals.slice(0, 4));
	const one = $derived(shown.length === 1);
	const cell = $derived(Math.floor(one ? size * 0.75 : size * 0.42));
	const label = $derived(shown.map(signalName).join(', ') || 'No icons');

	const COLOURS: Record<string, string> = {
		red: '#e5484d',
		green: '#46a758',
		blue: '#3e63dd',
		yellow: '#f5d90a',
		pink: '#e93d82',
		cyan: '#05a2c2',
		white: '#eeeeee',
		grey: '#8b8d98',
		black: '#222222'
	};

	/** The signal's icon when there is one; else "virtual:signal-7" → {glyph: "7"}, "virtual:signal-blue" → {colour}. */
	const parse = (signal: string) => {
		const { kind, name } = signalIcon(signal);
		if (kind !== 'virtual-signal' || iconUrl(icons, kind, name)) return { icon: true } as const;
		const rest = name.replace(/^signal-/, '');
		if (/^[0-9A-Z]$/.test(rest)) return { glyph: rest } as const;
		if (COLOURS[rest]) return { colour: COLOURS[rest] } as const;
		return { glyph: '◆' } as const;
	};

	const tint = $derived(
		kind === 'blueprint_book' ? 'border-sky-700 bg-sky-950/80 border-l-4' : 'border-sky-800/80 bg-sky-950/60'
	);
</script>

<span
	role="img"
	aria-label="{kind === 'blueprint_book' ? 'Book' : 'Blueprint'} icons: {label}"
	title={label}
	class="inline-grid shrink-0 place-content-center rounded border align-middle {tint}"
	style:width="{size}px"
	style:height="{size}px"
>
	<span class="grid place-items-center gap-px {one ? '' : 'grid-cols-2'}">
		{#each shown as s, i (i)}
			{@const p = parse(s)}
			<span
				class="grid place-items-center {shown.length === 3 && i === 2 ? 'col-span-2' : ''}"
				style:width="{cell}px"
				style:height="{cell}px"
			>
				{#if 'icon' in p}
					<Icon {icons} signal={s} label="" size={cell} />
				{:else if 'colour' in p}
					<span class="rounded-full" style:width="{cell * 0.7}px" style:height="{cell * 0.7}px" style:background={p.colour}></span>
				{:else}
					<span class="leading-none font-bold text-stone-100" style:font-size="{cell * 0.85}px">{p.glyph}</span>
				{/if}
			</span>
		{/each}
	</span>
</span>
