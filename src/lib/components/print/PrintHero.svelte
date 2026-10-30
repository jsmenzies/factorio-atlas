<script lang="ts">
	import BlueprintIcons from '#lib/components/BlueprintIcons.svelte';
	import RichText from '#lib/components/RichText.svelte';
	import ShotLightbox from '#lib/components/ShotLightbox.svelte';
	import type { IconSet } from '#lib/icons.js';
	import type { NodeAnalysis, PrintAnalysis } from '#lib/server/pipeline/analyze.js';
	import type { PagePrint } from '#lib/server/pipeline/print-doc.js';
	import { showsFavourites } from '#lib/print-id.js';
	import { plainText } from '#lib/richtext.js';
	import { NO_SHOT, type ShotView } from '#lib/screenshots.js';
	import { searchRel } from '#lib/search-seo.js';

	/**
	 * The top of the print page, full width: back link, the print's icons, title and author, how
	 * many pages or entities, and the copy button. Version, mods, stage, Space Age and planets are in
	 * the sidebar (PrintSidebar), what it makes on the Overview and Produces tabs. Behind it, dimmed:
	 * our copy of the author's screenshot (its 16:9 crop, at most 960 px), or Imgur's while ours isn't
	 * there yet (shotView), else the biggest rendered page, else a grid.
	 */
	let {
		print,
		analysis: a,
		title,
		root,
		shot,
		cover,
		coverIndex,
		copyLabel,
		oncopy,
		icons
	}: {
		print: PagePrint;
		analysis: PrintAnalysis;
		title: string;
		root: NodeAnalysis | undefined;
		/** Our copy of the author's screenshot (#lib/screenshots.ts shotView). */
		shot: ShotView;
		/** The biggest rendered page's overview, for prints without a screenshot. */
		cover: { path: string; url: string } | null;
		/** That page's number in the book (1-based), or null for a single blueprint. */
		coverIndex: number | null;
		copyLabel: string;
		oncopy: () => void;
		icons: IconSet;
	} = $props();

	const plainTitle = $derived(plainText(title));
	let lightbox = $state<ShotLightbox>();

	const contents = $derived(
		a.bookCount
			? `${a.blueprintCount} page${a.blueprintCount === 1 ? '' : 's'}${a.bookCount > 1 ? ` in ${a.bookCount} books` : ''}`
			: `${a.entityCount.toLocaleString()} entities`
	);
	// Backdrop images that failed to load (a missing file, an Imgur error), by URL: the header then
	// drops to the next backdrop instead of showing a broken image.
	let failed = $state<string[]>([]);
	const fail = (url: string) => {
		if (!failed.includes(url)) failed = [...failed, url];
	};
	// Why the author's screenshot isn't shown, when the print has one.
	const noShot = $derived(print.image_id ? NO_SHOT[shot.state] ?? 'Screenshot unavailable' : null);
	const backdrop = $derived(
		shot.backdrop && !failed.includes(shot.backdrop.src) ? 'screenshot' : cover && !failed.includes(cover.url) ? 'render' : 'grid'
	);
</script>

<section aria-label="About this print" class="relative -mt-6 pt-8 pb-5">
	<div aria-hidden="true" class="pointer-events-none absolute inset-y-0 left-1/2 w-screen -translate-x-1/2 overflow-hidden bg-stone-950">
		{#if backdrop === 'screenshot' && shot.backdrop}
			{@const b = shot.backdrop}
			<!-- The page's largest image above the fold: fetched first, decoded off the main thread. -->
			<img
				referrerpolicy={shot.imgur ? 'no-referrer' : undefined}
				src={b.src}
				width={b.width}
				height={b.height}
				alt=""
				fetchpriority="high"
				decoding="async"
				onerror={() => fail(b.src)}
				class="size-full object-cover opacity-80"
			/>
		{:else if backdrop === 'render' && cover}
			<img src={cover.url} alt="" onerror={() => fail(cover.url)} class="size-full object-cover opacity-45" />
		{:else}
			<div
				class="size-full [background-image:linear-gradient(to_right,rgb(68_64_60/0.25)_1px,transparent_1px),linear-gradient(to_bottom,rgb(68_64_60/0.25)_1px,transparent_1px)] [background-size:32px_32px]"
			></div>
		{/if}
		<div class="absolute inset-0 bg-linear-to-r from-stone-950/90 via-stone-950/55 to-stone-950/15"></div>
		<div class="absolute inset-0 bg-linear-to-t from-stone-950 via-transparent to-stone-950/20"></div>
	</div>

	<!-- The gap under the back link and the short bottom padding add up to the header's old height. -->
	<div class="relative">
		<a href="/" class="text-sm text-stone-300 hover:text-amber-300">← Search</a>
		<div class="mt-10 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
			<div class="min-w-0 space-y-4">
				<div class="flex items-center gap-4">
					{#if root?.icons.length}<BlueprintIcons {icons} signals={root.icons} kind={root.kind} size={64} />{/if}
					<div class="min-w-0">
						<h1 class="text-3xl font-bold text-stone-50 sm:text-4xl"><RichText text={title} {icons} size={34} /></h1>
						<p class="mt-1 text-stone-300">
							by {#if print.author_id}<a
									class="text-stone-100 underline decoration-stone-500 hover:text-amber-300"
									href="/?author={print.author_id}"
									rel={searchRel(`/?author=${print.author_id}`)}
									title="Every print by this author">{print.author_name ?? 'unknown author'}</a
								>{:else}{print.author_name ?? 'unknown author'}{/if}{#if showsFavourites(print.source, print.id)} · ★ {print.favorites}{/if}
						</p>
					</div>
				</div>
				<p class="text-stone-200">{contents}</p>
			</div>

			<div class="flex shrink-0 flex-col items-stretch gap-2 lg:w-72">
				<button onclick={oncopy} class="h-14 rounded bg-amber-500 px-6 text-lg font-semibold text-stone-950 hover:bg-amber-400">{copyLabel}</button>
				<p class="text-center text-xs text-stone-400">
					{#if backdrop === 'screenshot' && shot.large}
						<button type="button" onclick={() => lightbox?.open()} class="text-stone-300 underline decoration-stone-500 hover:text-amber-300">Author's screenshot ↗</button>
					{:else if backdrop === 'render'}
						{noShot ?? 'No author screenshot'}{coverIndex ? ` · showing page ${coverIndex}` : ' · showing the render'}
					{:else}
						{noShot ?? 'No screenshot or render'}
					{/if}
				</p>
			</div>
		</div>
	</div>
</section>

{#if shot.large && shot.full}
	<ShotLightbox bind:this={lightbox} large={shot.large} full={shot.full} title={plainTitle} imgur={shot.imgur} />
{/if}
