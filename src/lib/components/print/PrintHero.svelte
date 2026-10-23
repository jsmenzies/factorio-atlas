<script lang="ts">
	import BlueprintIcons from '#lib/components/BlueprintIcons.svelte';
	import Lightbox from '#lib/components/Lightbox.svelte';
	import RichText from '#lib/components/RichText.svelte';
	import { imgurUrl } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';
	import type { NodeAnalysis, PrintAnalysis } from '#lib/server/pipeline/analyze.js';
	import type { PagePrint } from '#lib/server/pipeline/print-doc.js';
	import { plainText } from '#lib/richtext.js';
	import { searchRel } from '#lib/search-seo.js';

	/**
	 * The top of the print page, full width: back link, the print's icons, title and author, how
	 * many pages or entities, and the copy button. Version, mods, stage, Space Age and planets are in
	 * the sidebar (PrintSidebar), what it makes on the Overview and Produces tabs. Behind it, dimmed: the author's screenshot, else the biggest rendered page, else a grid.
	 */
	let {
		print,
		analysis: a,
		title,
		root,
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
		/** The biggest rendered page's overview, for prints without a screenshot. */
		cover: { path: string; url: string } | null;
		/** That page's number in the book (1-based), or null for a single blueprint. */
		coverIndex: number | null;
		copyLabel: string;
		oncopy: () => void;
		icons: IconSet;
	} = $props();

	const plainTitle = $derived(plainText(title));
	let lightbox = $state<Lightbox>();

	const contents = $derived(
		a.bookCount
			? `${a.blueprintCount} page${a.blueprintCount === 1 ? '' : 's'}${a.bookCount > 1 ? ` in ${a.bookCount} books` : ''}`
			: `${a.entityCount.toLocaleString()} entities`
	);
	// Backdrop images that failed to load (an Imgur error, a missing render file), by URL: the
	// header then drops to the next backdrop instead of showing a broken image.
	let failed = $state<string[]>([]);
	const fail = (url: string) => {
		if (!failed.includes(url)) failed = [...failed, url];
	};
	const shot = $derived(print.image_id ? imgurUrl(print.image_id, print.image_type, 'preview') : null);
	const backdrop = $derived(shot && !failed.includes(shot) ? 'screenshot' : cover && !failed.includes(cover.url) ? 'render' : 'grid');
</script>

<section aria-label="About this print" class="relative -mt-6 pt-8 pb-5">
	<div aria-hidden="true" class="pointer-events-none absolute inset-y-0 left-1/2 w-screen -translate-x-1/2 overflow-hidden bg-stone-950">
		{#if backdrop === 'screenshot' && shot}
			<img referrerpolicy="no-referrer" src={shot} alt="" onerror={() => fail(shot)} class="size-full object-cover opacity-80" />
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
								>{:else}unknown author{/if} · ★ {print.favorites}
						</p>
					</div>
				</div>
				<p class="text-stone-200">{contents}</p>
			</div>

			<div class="flex shrink-0 flex-col items-stretch gap-2 lg:w-72">
				<button onclick={oncopy} class="h-14 rounded bg-amber-500 px-6 text-lg font-semibold text-stone-950 hover:bg-amber-400">{copyLabel}</button>
				<p class="text-center text-xs text-stone-400">
					{#if backdrop === 'screenshot'}
						<button type="button" onclick={() => lightbox?.open()} class="text-stone-300 underline decoration-stone-500 hover:text-amber-300">Author's screenshot ↗</button>
					{:else if backdrop === 'render'}
						{print.image_id ? 'Screenshot unavailable' : 'No author screenshot'}{coverIndex ? ` · showing page ${coverIndex}` : ' · showing the render'}
					{:else}
						{print.image_id ? 'Screenshot unavailable' : 'No screenshot or render'}
					{/if}
				</p>
			</div>
		</div>
	</div>
</section>

{#if print.image_id}
	<Lightbox bind:this={lightbox} label="Screenshot of {plainTitle}">
		<img
			referrerpolicy="no-referrer"
			src={imgurUrl(print.image_id, print.image_type, 'original')}
			alt="Screenshot of {plainTitle}"
			class="mx-auto block max-h-[calc(95vh-3rem)] max-w-[95vw] object-contain"
		/>
	</Lightbox>
{/if}
