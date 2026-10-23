<script lang="ts" module>
	/** A page's thumbnail: its srcset and the overview's size (for the aspect only). */
	export interface PageThumb {
		srcset: string;
		w: number;
		h: number;
	}
</script>

<script lang="ts">
	import { tick } from 'svelte';
	import BlueprintIcons from '#lib/components/BlueprintIcons.svelte';
	import type { PageGroup } from '#lib/book-groups.js';
	import type { IconSet } from '#lib/icons.js';
	import { plainClick } from '#lib/links.js';

	/**
	 * The full-screen render's page picker: a search box over every page of a book, shown as
	 * thumbnails in groups (stages or sub-books). Arrow keys move through the matches, Enter opens
	 * one, Esc closes. Pages without a thumbnail (no render) show their icons. Cards are links, so
	 * a middle click opens a page in a new tab; a plain click calls `onpick`.
	 */
	let {
		groups,
		current,
		pages,
		thumbs = {},
		icons,
		href,
		onpick,
		onclose
	}: {
		groups: PageGroup[];
		current: string | null;
		/** Per page: its icons and the lowercase text the search matches. */
		pages: Record<string, { icons: string[]; find: string | null } | undefined>;
		thumbs?: Record<string, PageThumb>;
		icons: IconSet;
		href: (path: string) => string;
		onpick: (path: string) => void;
		onclose: () => void;
	} = $props();

	let query = $state('');
	const words = $derived(query.trim().toLowerCase().split(/\s+/).filter(Boolean));
	const matches = (p: PageGroup['pages'][number]) => {
		const text = `${p.n} ${p.title.toLowerCase()} ${pages[p.path]?.find ?? ''}`;
		return words.every((w) => text.includes(w));
	};
	const shown = $derived(
		words.length ? groups.map((g) => ({ ...g, pages: g.pages.filter(matches) })).filter((g) => g.pages.length) : groups
	);
	const flat = $derived(shown.flatMap((g) => g.pages));
	const total = $derived(groups.reduce((n, g) => n + g.pages.length, 0));

	/** The page the arrow keys are on: the current page at first, else the first match. */
	let active = $state<string | null>(null);
	$effect(() => {
		const list = flat;
		if (!list.some((p) => p.path === active)) active = list.find((p) => p.path === current)?.path ?? list[0]?.path ?? null;
	});

	let scroller = $state<HTMLDivElement>();
	let input = $state<HTMLInputElement>();
	const cardOf = (path: string | null) => (path === null ? null : scroller?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`));

	// Open on the current page, with the search box focused.
	$effect(() => {
		input?.focus();
		tick().then(() => {
			cardOf(current)?.scrollIntoView({ block: 'nearest' });
			measure();
		});
	});

	/** Columns in the grids, for ↑ and ↓. */
	const columns = () => {
		const grid = scroller?.querySelector('[data-grid]');
		return grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 1;
	};
	const move = (by: number) => {
		const i = flat.findIndex((p) => p.path === active);
		const next = flat[Math.max(0, Math.min(flat.length - 1, (i < 0 ? 0 : i) + by))];
		if (!next) return;
		active = next.path;
		cardOf(next.path)?.scrollIntoView({ block: 'nearest' });
	};
	const onkeydown = (e: KeyboardEvent) => {
		if (e.key === 'ArrowDown') move(columns());
		else if (e.key === 'ArrowUp') move(-columns());
		else if (e.key === 'ArrowRight') move(1);
		else if (e.key === 'ArrowLeft') move(-1);
		else if (e.key === 'Enter' && active !== null) onpick(active);
		else if (e.key === 'Escape') onclose();
		else return;
		e.preventDefault();
	};

	// "Stages 4–16 · 37 more pages, scroll ↓": what lies below the panel's bottom edge.
	let below = $state<{ pages: number; from: number | null; to: number | null }>({ pages: 0, from: null, to: null });
	const measure = () => {
		const el = scroller;
		if (!el) return;
		const bottom = el.getBoundingClientRect().bottom;
		let pagesBelow = 0;
		const stages: number[] = [];
		el.querySelectorAll<HTMLElement>('[data-path]').forEach((card) => {
			if (card.getBoundingClientRect().top < bottom - 24) return;
			pagesBelow++;
			const stage = Number(card.dataset.stage);
			if (card.dataset.stage && !stages.includes(stage)) stages.push(stage);
		});
		below = { pages: pagesBelow, from: stages[0] ?? null, to: stages.at(-1) ?? null };
	};
	$effect(() => {
		void shown;
		tick().then(measure);
	});
</script>

<div
	class="flex max-h-[calc(100dvh-14rem)] w-[calc(100vw-2.5rem)] sm:max-h-[min(42rem,calc(100dvh-9rem))] flex-col overflow-hidden rounded-xl border border-stone-700 bg-stone-900/95 shadow-2xl backdrop-blur sm:w-[min(54rem,calc(100vw-4.5rem))]"
	role="dialog"
	aria-label="Book pages"
>
	<div class="flex items-center gap-3 border-b border-stone-800 p-3 sm:p-4">
		<label class="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-stone-700 bg-stone-950 px-3 py-2 focus-within:border-amber-500/70">
			<svg viewBox="0 0 16 16" class="size-3.5 shrink-0 text-stone-500" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
				<circle cx="7" cy="7" r="5" />
				<path d="m11 11 3.5 3.5" stroke-linecap="round" />
			</svg>
			<input
				bind:this={input}
				bind:value={query}
				{onkeydown}
				type="search"
				class="min-w-0 flex-1 bg-transparent text-sm text-stone-100 outline-none placeholder:text-stone-500"
				placeholder="Find a page: name or item"
				aria-label="Find a page by name or item"
				aria-controls="page-grid"
				aria-activedescendant={active !== null ? `page-${active}` : undefined}
				autocomplete="off"
			/>
		</label>
		<span class="hidden shrink-0 text-xs text-stone-500 sm:block">↑↓←→ to move · Enter to open</span>
	</div>

	<div bind:this={scroller} id="page-grid" class="min-h-0 flex-1 space-y-5 overflow-y-auto p-3 sm:p-4" onscroll={measure}>
		{#each shown as g, gi (gi)}
			<section aria-label={g.title ?? 'Pages'}>
				{#if g.title}
					<h2 class="mb-2 flex items-baseline justify-between gap-2 text-xs font-semibold tracking-wider text-stone-400 uppercase">
						<span class="truncate">{g.title}</span>
						<span class="font-normal text-stone-500 tabular-nums">{g.pages.length}</span>
					</h2>
				{/if}
				<div data-grid class="grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-3 md:grid-cols-4">
					{#each g.pages as p (p.path)}
						{@const thumb = thumbs[p.path]}
						{@const here = p.path === current}
						<a
							id="page-{p.path}"
							data-path={p.path}
							data-stage={g.stage ?? undefined}
							href={href(p.path)}
							aria-current={here ? 'page' : undefined}
							class="group block min-w-0 rounded-lg outline-none"
							onclick={(e) => {
								if (!plainClick(e)) return;
								e.preventDefault();
								onpick(p.path);
							}}
							onpointerenter={() => (active = p.path)}
						>
							<span
								class="grid aspect-video place-items-center overflow-hidden rounded-md bg-stone-950 ring-1 transition {here
									? 'ring-2 ring-amber-400'
									: p.path === active
										? 'ring-2 ring-stone-400'
										: 'ring-stone-800 group-hover:ring-stone-600'}"
							>
								{#if thumb}
									<img
										srcset={thumb.srcset}
										sizes="(min-width: 768px) 13rem, (min-width: 640px) 17rem, 50vw"
										alt=""
										loading="lazy"
										width={thumb.w}
										height={thumb.h}
										class="h-full w-full object-contain"
									/>
								{:else if pages[p.path]?.icons.length}
									<BlueprintIcons {icons} signals={pages[p.path]!.icons} size={48} />
								{/if}
							</span>
							<span class="mt-1.5 flex min-w-0 gap-1.5 text-sm {here ? 'text-amber-300' : 'text-stone-200 group-hover:text-stone-50'}">
								<span class="shrink-0 text-stone-500 tabular-nums">{p.n}</span>
								<span class="truncate" title={p.title}>{p.title}</span>
							</span>
						</a>
					{/each}
				</div>
			</section>
		{:else}
			<p class="py-8 text-center text-sm text-stone-500">No page matches “{query.trim()}”.</p>
		{/each}
	</div>

	{#if below.pages}
		<p class="border-t border-stone-800 px-4 py-2 text-center text-xs text-stone-500">
			{below.from === null ? '' : `${below.from === below.to ? 'Stage' : 'Stages'} ${below.from}${below.from === below.to ? '' : `–${below.to}`} · `}{below.pages}
			more {below.pages === 1 ? 'page' : 'pages'}, scroll ↓
		</p>
	{:else if words.length}
		<p class="border-t border-stone-800 px-4 py-2 text-center text-xs text-stone-500">{flat.length} of {total} pages</p>
	{/if}
</div>
