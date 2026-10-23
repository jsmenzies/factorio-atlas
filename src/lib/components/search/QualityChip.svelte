<script lang="ts">
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import Icon from '#lib/components/Icon.svelte';
	import type { IconSet } from '#lib/icons.js';
	import { ANY_QUALITY_ICON, QUALITY_LEVELS, QUALITY_WORDS, type QualityLevel } from '#lib/quality.js';
	import { searchRel } from '#lib/search-seo.js';

	/**
	 * A Makes, Built with or Modules filter chip, which can take a quality. The chip's body opens a
	 * dropdown of the levels, each with its count in the current search, the same on phones (taller
	 * rows for touch); picking one runs the search with `@<level>` on the value. The × removes the filter. A faint
	 * any-quality badge and a caret say the body does something. `hover` (a dev-only trial, `?qhover=1`)
	 * also slides the levels out beside the chip when the pointer rests on it.
	 */
	let {
		label,
		icon,
		quality,
		countsUrl,
		hrefFor,
		removeHref,
		icons,
		hover = false
	}: {
		/** The filter in words, e.g. "Built with Beacon". */
		label: string;
		/** The item's signal, without the quality. */
		icon: string;
		quality: QualityLevel | null;
		/** `/quality-levels` for this chip in this search: matches at any quality and each level or above, fetched on opening. */
		countsUrl: string;
		hrefFor: (quality: QualityLevel | null) => string;
		removeHref: string;
		icons: IconSet;
		hover?: boolean;
	} = $props();

	const uid = $props.id();
	const LEVELS = ['any', ...QUALITY_LEVELS] as const;
	type Level = (typeof LEVELS)[number];
	const current = $derived<Level>(quality ?? 'any');
	const levelOf = (l: Level) => (l === 'any' ? null : l);
	const levelIcon = (l: Level) => (l === 'any' ? ANY_QUALITY_ICON : `quality:${l}`);
	// A level no print in this search has can't be picked (the current one always can).
	// Counts load when the choice first opens, and again for another search (the URL changes with it).
	let loaded = $state<{ url: string; counts: Record<Level, number> } | null>(null);
	const counts = $derived(loaded?.url === countsUrl ? loaded.counts : undefined);
	const loadCounts = async () => {
		if (counts) return;
		const url = countsUrl;
		try {
			const res = await fetch(url);
			if (res.ok) loaded = { url, counts: await res.json() };
		} catch {
			// Offline or failed: the choice works without counts.
		}
	};
	const disabled = (l: Level) => l !== current && counts?.[l] === 0;
	const name = $derived(`${label}, ${QUALITY_WORDS[current].long.toLowerCase()}`);

	let open = $state(false);
	let strip = $state(false);
	let root: HTMLSpanElement;
	let trigger: HTMLButtonElement;
	let list = $state<HTMLDivElement>();

	// The dropdown is fixed to the viewport, so no parent clips it: under the chip, or above it when
	// it would run off the bottom, or (room for neither) as low as fits; shifted left near the right
	// edge; never wider than the screen less its gutters. Placed after a first, hidden render that
	// measures its height.
	const WIDTH = 192;
	const GUTTER = 16;
	let place = $state<{ top: number; left: number; width: number } | null>(null);
	const position = () => {
		const chip = root.getBoundingClientRect();
		const vw = document.documentElement.clientWidth;
		const width = Math.min(WIDTH, vw - 2 * GUTTER);
		const height = list?.parentElement?.offsetHeight ?? 0;
		const below = chip.bottom + 4;
		const above = chip.top - 4 - height;
		const bottom = window.innerHeight - GUTTER;
		const top = below + height <= bottom ? below : above >= GUTTER ? above : Math.max(GUTTER, bottom - height);
		place = { top, left: Math.min(Math.max(chip.left, GUTTER), vw - GUTTER - width), width };
	};

	const options = () => [...(list?.querySelectorAll<HTMLElement>('[role="option"]:not([aria-disabled="true"])') ?? [])];
	const show = async () => {
		loadCounts();
		open = true;
		strip = false;
		place = null;
		await tick();
		position();
		// Focus once it's visible (placed); no scroll on focus, since scrolling closes the dropdown.
		await tick();
		(list?.querySelector<HTMLElement>('[aria-selected="true"]') ?? options()[0])?.focus({ preventScroll: true });
	};
	const close = (refocus = false) => {
		open = false;
		place = null;
		if (refocus) trigger.focus();
	};

	const onTriggerKeydown = (e: KeyboardEvent) => {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			show();
		} else if (e.key === 'Delete' || e.key === 'Backspace') {
			e.preventDefault();
			goto(removeHref);
		}
	};
	const onListKeydown = (e: KeyboardEvent) => {
		const all = options();
		const at = all.indexOf(document.activeElement as HTMLElement);
		const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
		if (step) {
			e.preventDefault();
			all[(at + step + all.length) % all.length]?.focus();
		} else if (e.key === 'Home' || e.key === 'End') {
			e.preventDefault();
			all.at(e.key === 'Home' ? 0 : -1)?.focus();
		} else if (e.key === ' ') {
			e.preventDefault();
			(document.activeElement as HTMLElement | null)?.click();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			close(true);
		} else if (e.key === 'Tab') close();
	};
	const onWindowPointerdown = (e: PointerEvent) => {
		if ((open || strip) && !root.contains(e.target as Node)) {
			open = false;
			strip = false;
		}
	};

	// Hover trial: the strip opens only once the pointer has rested on the chip, so crossing it on the
	// way to the results never opens it; it closes a moment after the pointer leaves.
	const REST_MS = 450;
	const LEAVE_MS = 250;
	let restTimer: ReturnType<typeof setTimeout> | undefined;
	let leaveTimer: ReturnType<typeof setTimeout> | undefined;
	const canHover = () => hover && matchMedia('(hover: hover) and (pointer: fine)').matches;
	const onPointermove = () => {
		if (!canHover() || open || strip) return;
		clearTimeout(restTimer);
		restTimer = setTimeout(() => {
			loadCounts();
			strip = true;
		}, REST_MS);
	};
	const onPointerenter = () => clearTimeout(leaveTimer);
	const onPointerleave = () => {
		clearTimeout(restTimer);
		if (strip) leaveTimer = setTimeout(() => (strip = false), LEAVE_MS);
	};
</script>

<!-- Scrolling the results or resizing moves the chip away from the dropdown, so either closes it. -->
<svelte:window onpointerdown={onWindowPointerdown} onscroll={() => open && close()} onresize={() => open && close()} />

{#snippet badge(l: Level, size: number)}
	<Icon {icons} signal={levelIcon(l)} label="" {size} />
{/snippet}

<span
	bind:this={root}
	class="relative inline-flex items-stretch rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-200"
	role="group"
	aria-label={name}
	onpointermove={onPointermove}
	onpointerenter={onPointerenter}
	onpointerleave={onPointerleave}
>
	<button
		bind:this={trigger}
		type="button"
		class="relative flex items-center gap-1 rounded-l-full py-0.5 pr-1 pl-1 before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-[''] hover:bg-amber-500/20 focus-visible:outline-2 focus-visible:outline-amber-400"
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-controls="{uid}-levels"
		aria-label="{name}. Choose quality"
		title="{name}. Click to choose a quality"
		onclick={() => (open ? close() : show())}
		onkeydown={onTriggerKeydown}
	>
		<span class="relative inline-flex">
			<Icon {icons} signal={icon} label="" size={20} />
			<span class="absolute -bottom-1 -left-1 leading-none {quality ? '' : 'opacity-45'}">{@render badge(current, 11)}</span>
			{#if quality && quality !== 'legendary'}
				<span aria-hidden="true" class="absolute -top-1.5 -right-1.5 text-[11px] leading-none font-bold text-amber-300">+</span>
			{/if}
		</span>
		<svg aria-hidden="true" viewBox="0 0 12 12" class="size-2.5 fill-current text-amber-400"><path d="M2.5 4.5 6 8l3.5-3.5z" /></svg>
	</button>
	{#if strip}
		<!-- Hover trial: the levels beside the chip; their counts are in the tooltip. -->
		<span class="flex items-center gap-0.5 border-l border-amber-500/25 px-1">
			{#each LEVELS as l (l)}
				{#if disabled(l)}
					<span class="grid size-6 place-items-center opacity-30" title="{QUALITY_WORDS[l].long}: none">{@render badge(l, 16)}</span>
				{:else}
					{@const href = hrefFor(levelOf(l))}
					<a
						{href}
						rel={searchRel(href)}
						class="grid size-6 place-items-center rounded hover:bg-amber-500/25 {l === current ? 'bg-amber-500/30' : ''}"
						title="{QUALITY_WORDS[l].long}{counts ? `: ${counts[l].toLocaleString('en')}` : ''}"
						aria-label="{QUALITY_WORDS[l].long}{counts ? `, ${counts[l].toLocaleString('en')} prints` : ''}"
						onclick={() => (strip = false)}>{@render badge(l, 16)}</a
					>
				{/if}
			{/each}
		</span>
	{/if}
	<a
		href={removeHref}
		rel={searchRel(removeHref)}
		class="relative flex items-center rounded-r-full border-l border-amber-500/25 pr-2.5 pl-1.5 text-amber-400 before:absolute before:-inset-y-1.5 before:-right-1 before:left-0 before:content-[''] hover:bg-amber-500/20"
		aria-label="Remove filter: {label}"
		title="Remove filter">×</a
	>

	{#if open}
		<!-- A dropdown everywhere; rows are 44 px tall for a coarse pointer (touch). -->
		<div
			class="fixed z-50 rounded-lg border border-stone-600 bg-stone-900 p-1 text-sm text-stone-200 shadow-xl"
			style:top="{place?.top ?? 0}px"
			style:left="{place?.left ?? 0}px"
			style:width="{place?.width ?? WIDTH}px"
			style:visibility={place ? 'visible' : 'hidden'}
		>
			<div bind:this={list} id="{uid}-levels" role="listbox" aria-label="Quality: {label}" tabindex="-1" onkeydown={onListKeydown}>
				{#each LEVELS as l (l)}
					{@const off = disabled(l)}
					{@const href = off ? undefined : hrefFor(levelOf(l))}
					<a
						{href}
						rel={href ? searchRel(href) : undefined}
						role="option"
						aria-selected={l === current}
						aria-disabled={off}
						aria-label="{QUALITY_WORDS[l].long}{counts ? `, ${counts[l].toLocaleString('en')} prints` : ''}"
						tabindex="-1"
						class="flex items-center gap-2 rounded px-2 py-0.5 focus:outline-none pointer-coarse:min-h-11 {l === current
							? 'bg-amber-500/15 text-amber-300'
							: off
								? 'opacity-35'
								: 'hover:bg-stone-800 focus:bg-stone-800'}"
						onclick={() => close()}
					>
						{@render badge(l, 16)}
						<span class="flex-1">{QUALITY_WORDS[l].short}</span>
						<span class="text-xs text-stone-500 tabular-nums">{counts ? counts[l].toLocaleString('en') : '…'}</span>
					</a>
				{/each}
			</div>
		</div>
	{/if}
</span>
