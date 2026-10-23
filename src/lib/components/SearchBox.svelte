<script lang="ts">
	import { onMount, tick } from 'svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { iconUrl, signalIcon, type IconSet } from '#lib/icons.js';
	import {
		SECTIONS,
		TABS,
		gridMove,
		gridRows,
		initialTab,
		landOn,
		printCount,
		score,
		sectionHeading,
		tabStep,
		type Cell,
		type PickerItem
	} from '#lib/picker.js';

	let {
		value = '',
		items,
		icons,
		onpick
	}: { value?: string; items: PickerItem[]; icons: IconSet; onpick: (item: PickerItem) => void } = $props();

	const uid = $props.id();

	// The query from the URL, then whatever is typed (the page also re-creates the box with `{#key}`
	// when the query changes, which resets the menu too).
	let text = $derived(value);
	let open = $state(false);
	let input: HTMLInputElement;
	let root: HTMLDivElement;

	// An empty box browses a crafting menu (tabs + icon grid); typing switches to a grouped list of matches.
	const browsing = $derived(!text.trim());

	// ---- Typed: grouped matches, highlighted with aria-activedescendant while focus stays in the input.
	let active = $state(-1);
	const PER_SECTION = 8;

	// Sections in fixed order; within each, best match first, then the game's own order.
	const groups = $derived.by(() => {
		if (browsing) return [];
		const scored = items.map((item) => ({ item, s: score(item, text) })).filter((x) => x.s > 0);
		return SECTIONS.map((section) => ({
			section,
			items: scored
				.filter((x) => x.item.section === section)
				.sort((a, b) => b.s - a.s || b.item.n - a.item.n || a.item.sort.localeCompare(b.item.sort))
				.slice(0, PER_SECTION)
				.map((x) => x.item)
		})).filter((g) => g.items.length);
	});
	const flat = $derived(groups.flatMap((g) => g.items));

	// ---- Browsing: crafting menu. Focus really moves into it (roving tabindex), so it is a dialog, not a listbox.
	const TAB_KEY = 'atlas.picker.tab';
	let remembered = $state<string | null>(null);
	let chosen = $state<string | null>(null);
	const tab = $derived(chosen ?? initialTab(items, remembered));
	const tabIndex = $derived(TABS.findIndex((t) => t.section === tab));
	const rows = $derived(gridRows(items.filter((i) => i.section === tab)));
	const lengths = $derived(rows.map((r) => r.length));
	// Raw: replaced, never mutated (and items stay the objects from `items`, not proxies).
	let cell = $state.raw<Cell>({ row: 0, col: 0 });
	let hovered = $state.raw<PickerItem | null>(null);
	let focused = $state.raw<PickerItem | null>(null);
	const caption = $derived(hovered ?? focused);

	// Every icon in the menu (≈ 350, under 1 MB, cached for a year) is fetched once the page is idle, so it
	// opens with them drawn: the tab icons and the tab it opens on first. The pointer or focus reaching the
	// box first starts them early. The Image objects are kept so the decoded bitmaps stay too.
	const warmed = new Map<string, HTMLImageElement>();
	const warm = (srcs: (string | undefined)[]) => {
		for (const src of srcs) {
			if (!src || warmed.has(src)) continue;
			const img = new Image();
			img.decoding = 'async';
			img.src = src;
			warmed.set(src, img);
		}
	};
	const itemIcon = (item: PickerItem) => {
		const { kind, name } = signalIcon(item.signal);
		return iconUrl(icons, kind, name);
	};
	const warmAll = () => warm(items.map(itemIcon));

	onMount(() => {
		try {
			remembered = localStorage.getItem(TAB_KEY);
		} catch {
			// Storage blocked (private mode, sandbox): fall back to the first tab with prints.
		}
		const warmIdle = () => {
			warm([...TABS.map((t) => iconUrl(icons, 'item', t.icon)), ...items.filter((i) => i.section === tab).map(itemIcon)]);
			warmAll();
		};
		if ('requestIdleCallback' in window) {
			const id = requestIdleCallback(warmIdle, { timeout: 3000 });
			return () => cancelIdleCallback(id);
		}
		const id = setTimeout(warmIdle, 1000);
		return () => clearTimeout(id);
	});

	const selectTab = (section: string) => {
		chosen = section;
		cell = { row: 0, col: 0 };
		hovered = null;
		try {
			localStorage.setItem(TAB_KEY, section);
		} catch {
			// Not remembered; harmless.
		}
	};

	const focusCell = async () => {
		await tick();
		root.querySelector<HTMLElement>(`[data-cell="${cell.row}-${cell.col}"]`)?.focus();
	};
	const focusTab = async () => {
		await tick();
		root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
	};
	const close = (refocus = false) => {
		open = false;
		active = -1;
		hovered = null;
		if (refocus) input.focus();
	};

	const pick = (item: PickerItem) => {
		close();
		// The text only found the item; the filter chip ("Makes" or "Uses") now shows the choice.
		text = '';
		onpick(item);
	};

	/** A plain character typed inside the menu goes to the search box (focus moves before the key lands). */
	const typesText = (e: KeyboardEvent) => e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey;

	const onInputKeydown = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			// The first Escape closes the menu; a second one lets the browser clear the search field.
			if (open) {
				e.preventDefault();
				close();
			}
		} else if (browsing) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				open = true;
				focusCell();
			}
		} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			open = true;
			const step = e.key === 'ArrowDown' ? 1 : -1;
			active = flat.length ? (active + step + flat.length) % flat.length : -1;
		} else if (e.key === 'Enter' && open && active >= 0 && flat[active]) {
			// A highlighted item wins; otherwise Enter submits the text search as usual.
			e.preventDefault();
			pick(flat[active]);
		}
	};

	const onTabKeydown = (e: KeyboardEvent) => {
		const next = tabStep(TABS.length, tabIndex, e.key);
		if (next !== null) {
			e.preventDefault();
			selectTab(TABS[next].section);
			focusTab();
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			focusCell();
		} else if (e.key === 'ArrowUp' || e.key === 'Escape') {
			e.preventDefault();
			if (e.key === 'Escape') close(true);
			else input.focus();
		} else if (typesText(e)) input.focus();
	};

	const onCellKeydown = (e: KeyboardEvent, at: Cell) => {
		if (e.key === 'Escape') {
			e.preventDefault();
			close(true);
			return;
		}
		if (typesText(e)) {
			input.focus();
			return;
		}
		const move = gridMove(lengths, at, e.key, e.ctrlKey);
		if (!move) return;
		e.preventDefault();
		if ('leave' in move) {
			focusTab();
			return;
		}
		if ('tab' in move) {
			selectTab(TABS[(tabIndex + move.tab + TABS.length) % TABS.length].section);
			cell = landOn(lengths, move.row, move.col) ?? { row: 0, col: 0 };
		} else cell = move;
		focusCell();
	};

	// Close when focus leaves the whole widget. Checked a tick later: switching tabs removes the focused
	// cell before the new one takes focus, and clicks inside the menu keep focus where it was.
	// `root` is gone by then if picking re-created the box (the page keys it on the query).
	const onfocusout = () =>
		setTimeout(() => {
			if (root && !root.contains(document.activeElement)) close();
		});
</script>

<div bind:this={root} class="relative min-w-0 flex-1" {onfocusout}>
	<svg
		aria-hidden="true"
		viewBox="0 0 20 20"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-500"
	>
		<circle cx="8.5" cy="8.5" r="5.5" />
		<path d="m13 13 4.5 4.5" stroke-linecap="round" />
	</svg>
	<input
		bind:this={input}
		type="search"
		name="q"
		enterkeyhint="search"
		bind:value={text}
		placeholder="Search prints, or pick what they make: red science, green circuits…"
		aria-label="Search prints"
		autocomplete="off"
		role="combobox"
		aria-haspopup={browsing ? 'dialog' : 'listbox'}
		aria-expanded={open && (browsing || flat.length > 0)}
		aria-controls={browsing ? `${uid}-menu` : `${uid}-options`}
		aria-activedescendant={!browsing && active >= 0 ? `${uid}-opt-${active}` : undefined}
		class="w-full rounded border border-stone-700 bg-stone-900 py-2 pr-3 pl-9 placeholder:text-stone-500 focus:border-amber-500 focus:outline-none"
		onpointerenter={warmAll}
		onfocus={() => {
			warmAll();
			open = true;
		}}
		onclick={() => (open = true)}
		oninput={() => {
			open = true;
			active = -1;
		}}
		onkeydown={onInputKeydown}
	/>

	{#if open && browsing}
		<!-- Mouse clicks inside the menu leave focus where it is (usually the input), so typing carries on. -->
		<div
			id="{uid}-menu"
			role="dialog"
			aria-label="Pick what the prints make, or a building they use"
			tabindex="-1"
			class="absolute top-full right-0 left-0 z-20 mt-1 rounded-lg border border-stone-700 bg-stone-900 shadow-xl sm:right-auto sm:w-[34rem] sm:max-w-full"
			onmousedown={(e) => e.preventDefault()}
		>
			<div role="tablist" aria-label="Item groups" class="flex border-b border-stone-700">
				{#each TABS as t (t.section)}
					{@const selected = t.section === tab}
					<button
						type="button"
						role="tab"
						id="{uid}-tab-{t.section}"
						aria-selected={selected}
						aria-controls="{uid}-panel"
						tabindex={selected ? 0 : -1}
						class="flex min-w-0 flex-1 flex-col items-center gap-0.5 border-b-2 px-1 pt-1.5 pb-1 text-[11px] {selected
							? 'border-amber-500 bg-stone-800 text-amber-200'
							: 'border-transparent text-stone-400 hover:bg-stone-800/60 hover:text-stone-200'} {t.section === 'Buildings'
							? 'border-l border-l-stone-700'
							: ''}"
						onclick={() => {
							const inMenu = root.contains(document.activeElement) && document.activeElement !== input;
							selectTab(t.section);
							if (inMenu) focusTab();
						}}
						onkeydown={onTabKeydown}
					>
						<Icon {icons} kind="item" name={t.icon} label="" size={28} />
						<span class="sr-only sm:not-sr-only sm:truncate">{t.section}</span>
					</button>
				{/each}
			</div>

			<div
				role="tabpanel"
				id="{uid}-panel"
				aria-labelledby="{uid}-tab-{tab}"
				class="max-h-[min(22rem,55vh)] overflow-y-auto p-1.5"
			>
				{#each rows as row, r (row[0].signal)}
					<div class="flex">
						{#each row as item, c (item.signal)}
							<button
								type="button"
								data-cell="{r}-{c}"
								tabindex={cell.row === r && cell.col === c ? 0 : -1}
								aria-label="{item.label}, {printCount(item.n)}"
								class="relative flex size-8 shrink-0 items-center justify-center rounded-sm border border-transparent hover:border-amber-500/60 hover:bg-stone-800 focus-visible:border-amber-400 focus-visible:bg-stone-800 focus-visible:outline-none sm:size-10 {item.n
									? ''
									: 'opacity-35 hover:opacity-100 focus-visible:opacity-100'}"
								onclick={() => pick(item)}
								onfocus={() => {
									cell = { row: r, col: c };
									focused = item;
								}}
								onblur={() => (focused = null)}
								onmouseenter={() => (hovered = item)}
								onmouseleave={() => (hovered = null)}
								onkeydown={(e) => onCellKeydown(e, { row: r, col: c })}
							>
								<Icon {icons} signal={item.signal} label="" size={28} />
								{#if item.n}
									<span
										class="absolute right-0 bottom-0 min-w-3.5 rounded-sm bg-stone-950/85 px-0.5 text-center text-[10px] leading-3.5 font-semibold text-amber-300"
										>{item.n}</span
									>
								{/if}
							</button>
						{/each}
					</div>
				{/each}
			</div>

			<!-- The same name and count are in each button's label, so screen readers skip this line. -->
			<p aria-hidden="true" class="flex min-h-8 items-center gap-2 border-t border-stone-700 px-3 py-1.5 text-xs text-stone-400">
				{#if caption}
					<span class="font-medium text-stone-100">{caption.label}</span>
					<span>{printCount(caption.n)}</span>
					{#if caption.nicknames[0]}<span class="truncate text-stone-500">“{caption.nicknames[0]}”</span>{/if}
				{:else if tab === 'Buildings'}
					Pick a building the prints are built with, or type to search.
				{:else}
					Pick what the prints make, or type to search.
				{/if}
			</p>
		</div>
	{:else if open && flat.length}
		<div
			id="{uid}-options"
			role="listbox"
			aria-label="Items"
			class="absolute top-full right-0 left-0 z-20 mt-1 max-h-[28rem] overflow-y-auto rounded-lg border border-stone-700 bg-stone-900 p-1 shadow-xl"
		>
			{#each groups as g (g.section)}
				<div role="group" aria-label={sectionHeading(g.section)}>
					<div class="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-stone-500 uppercase">{sectionHeading(g.section)}</div>
					{#each g.items as item (item.signal)}
						{@const i = flat.indexOf(item)}
						<!-- mousedown, not click: it fires before the input's blur closes the list. -->
						<div
							id="{uid}-opt-{i}"
							role="option"
							aria-selected={i === active}
							tabindex="-1"
							class="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm {i === active
								? 'bg-amber-500/15 text-amber-200'
								: 'hover:bg-stone-800'}"
							onmousedown={(e) => {
								e.preventDefault();
								pick(item);
							}}
							onmouseenter={() => (active = i)}
						>
							<Icon {icons} signal={item.signal} label={item.label} />
							<span class="min-w-0 flex-1 truncate">
								{item.label}
								{#if item.nicknames.some((nick) => nick.includes(text.toLowerCase().trim()))}
									<span class="ml-1 text-xs text-stone-500">“{item.nicknames.find((nick) => nick.includes(text.toLowerCase().trim()))}”</span>
								{/if}
							</span>
							<span class="text-xs {item.n ? 'text-stone-400' : 'text-stone-600'}">{item.n ? printCount(item.n) : 'none yet'}</span>
						</div>
					{/each}
				</div>
			{/each}
		</div>
	{/if}
</div>
