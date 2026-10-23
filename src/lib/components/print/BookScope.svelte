<script lang="ts">
	import PagePicker from '#lib/components/PagePicker.svelte';
	import type { PageGroup } from '#lib/book-groups.js';
	import type { IconSet } from '#lib/icons.js';
	import { plainClick } from '#lib/links.js';
	import type { PageThumb } from '#lib/viewer/thumbs.js';

	/**
	 * A book's page bar, under the tabs that count things (Produces, Entities, Inputs, Recipes) and
	 * kept across them: Whole book / This page, then ‹ the selected page › with the full-screen render's page picker.
	 * Picking or stepping to a page shows that page. ‹ › are links, so crawlers walk the book.
	 */
	let {
		groups,
		info,
		thumbs = {},
		selected,
		index,
		total,
		title,
		prev,
		next,
		scope = $bindable(),
		href,
		onpick,
		icons
	}: {
		groups: PageGroup[];
		/** Per page: its icons and the lowercase text the picker's search matches. */
		info: Record<string, { icons: string[]; find: string | null } | undefined>;
		thumbs?: Record<string, PageThumb>;
		selected: string;
		index: number;
		total: number;
		/** The selected page's plain-text title. */
		title: string;
		prev: string | null;
		next: string | null;
		scope: 'book' | 'page';
		href: (path: string) => string;
		onpick: (path: string) => void;
		icons: IconSet;
	} = $props();

	let open = $state(false);
	/** What the picker opens searching for (an item clicked on Produces or Inputs). */
	let query = $state('');
	/** Opens the picker, searching for `q`. */
	export const find = (q: string) => {
		query = q;
		open = true;
	};
	const pick = (path: string) => {
		open = false;
		scope = 'page';
		onpick(path);
	};
	const thumb = $derived(thumbs[selected]);
	let failed = $state<string | null>(null);
	const STEP = 'grid size-9 shrink-0 place-items-center rounded-lg border border-stone-700 bg-stone-800 text-stone-200';
</script>

<svelte:window
	onpointerdown={(e) => {
		if (open && !(e.target as Element).closest('[data-picker]')) open = false;
	}}
/>

<div class="relative mb-6 flex flex-wrap items-center gap-x-4 gap-y-2" data-picker>
	<div class="flex rounded-lg border border-stone-700 p-0.5 text-sm" role="group" aria-label="Show">
			{#each [{ id: 'book', label: 'Whole book' }, { id: 'page', label: 'This page' }] as s (s.id)}
				{@const on = scope === s.id}
				<button
					type="button"
					aria-pressed={on}
					onclick={() => (scope = s.id as 'book' | 'page')}
					class="rounded-md px-3 py-1 {on ? 'bg-stone-700 text-stone-50' : 'text-stone-400 hover:text-stone-200'}">{s.label}</button
				>
			{/each}
		</div>
	<div class="flex min-w-0 flex-1 items-center gap-1.5 {scope === 'book' ? 'opacity-60 hover:opacity-100' : ''}">
		{@render stepLink(prev, 'Previous page', '‹')}
		<button
			type="button"
			aria-expanded={open}
			aria-haspopup="dialog"
			onclick={() => {
				query = '';
				open = !open;
			}}
			class="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg border px-2 text-left text-sm transition sm:max-w-xl {open
				? 'border-amber-500/70 bg-amber-500/10'
				: 'border-stone-700 bg-stone-900 hover:border-stone-500'}"
		>
			<span class="relative grid h-6 w-10 shrink-0 place-items-center overflow-hidden rounded bg-stone-950">
				{#if thumb && failed !== selected}
					<img srcset={thumb.srcset} sizes="40px" alt="" onerror={() => (failed = selected)} class="absolute inset-0 size-full object-contain" />
				{/if}
			</span>
			<span class="shrink-0 font-mono text-stone-400 tabular-nums">{index + 1} / {total}</span>
			<span class="min-w-0 flex-1 truncate text-stone-100">{title}</span>
			<span class="shrink-0 text-[0.6rem] text-stone-400" aria-hidden="true">▼</span>
		</button>
		{@render stepLink(next, 'Next page', '›')}
	</div>

	{#if open}
		<div class="absolute top-full left-0 z-20 mt-2">
			{#key query}
				<PagePicker {groups} current={selected} pages={info} {thumbs} {icons} {href} initialQuery={query} onpick={pick} onclose={() => (open = false)} />
			{/key}
		</div>
	{/if}
</div>

{#snippet stepLink(path: string | null, label: string, arrow: string)}
	{#if path === null}
		<span class="{STEP} opacity-40" aria-hidden="true">{arrow}</span>
	{:else}
		<a
			href={href(path)}
			onclick={(e) => {
				if (!plainClick(e)) return;
				e.preventDefault();
				pick(path);
			}}
			class="{STEP} hover:bg-stone-700 hover:text-amber-300"
			aria-label={label}>{arrow}</a
		>
	{/if}
{/snippet}
