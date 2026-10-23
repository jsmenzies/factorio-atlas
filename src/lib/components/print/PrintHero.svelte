<script lang="ts">
	import BlueprintIcons from '#lib/components/BlueprintIcons.svelte';
	import Lightbox from '#lib/components/Lightbox.svelte';
	import MakesStrip from '#lib/components/MakesStrip.svelte';
	import RichText from '#lib/components/RichText.svelte';
	import type { MadeItem, ProductGroup } from '#lib/describe.js';
	import { imgurUrl, sourceUrl } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';
	import type { NodeAnalysis, PrintAnalysis } from '#lib/server/pipeline/analyze.js';
	import type { PagePrint } from '#lib/server/pipeline/print-doc.js';
	import { plainText } from '#lib/richtext.js';
	import { searchRel } from '#lib/search-seo.js';

	/**
	 * The top of the print page, full width: back link, the print's icons, title and author, a line
	 * of facts (contents, version, mods, stage, Space Age, planets), what it makes, and the copy
	 * button. Behind it, dimmed: the author's screenshot, else the biggest rendered page, else a grid.
	 */
	let {
		print,
		analysis: a,
		title,
		root,
		cover,
		coverIndex,
		main,
		groups,
		activeProduct,
		onpick,
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
		main: MadeItem[];
		groups: ProductGroup[];
		activeProduct: string | null;
		onpick?: (signal: string) => void;
		copyLabel: string;
		oncopy: () => void;
		icons: IconSet;
	} = $props();

	const plainTitle = $derived(plainText(title));
	let lightbox = $state<Lightbox>();

	const PLANETS = ['nauvis', 'vulcanus', 'fulgora', 'gleba', 'aquilo'];
	/** Short names for mods whose internal names are long. */
	const MOD_NAMES: Record<string, string> = { LogisticTrainNetwork: 'LTN', cybersyn: 'Cybersyn', 'space-exploration': 'Space Exploration' };
	const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

	const contents = $derived(
		a.bookCount
			? `${a.blueprintCount} page${a.blueprintCount === 1 ? '' : 's'}${a.bookCount > 1 ? ` in ${a.bookCount} books` : ''}`
			: `${a.entityCount.toLocaleString()} entities`
	);
	const versionHref = $derived(a.gameVersion ? `/?version=${encodeURIComponent(a.gameVersion)}` : null);
	const version = $derived(a.gameVersion ? [a.gameVersion, ...(a.claimedVersions.length ? [`claims ${a.claimedVersions.join(', ')}`] : [])].join(' · ') : null);
	const mods = $derived(a.mods.map((m) => MOD_NAMES[m] ?? m));
	const modded = $derived(mods.length ? `Needs mods: ${mods.slice(0, 3).join(', ')}${mods.length > 3 ? ` +${mods.length - 3}` : ''}` : null);
	// Planets only mean something from 2.0 on.
	const where = $derived.by(() => {
		if ((a.gameMajor ?? 0) < 2 || !a.placeableOn) return null;
		const planets = a.placeableOn.filter((p) => PLANETS.includes(p));
		if (planets.length === PLANETS.length) return 'any planet';
		if (!planets.length) return a.placeableOn.length ? a.placeableOn.join(', ').replaceAll('-', ' ') : null;
		return planets.length === 1 ? `${cap(planets[0])} only` : planets.map(cap).join(', ');
	});
	const notes = $derived(
		[a.stageGuess && (a.stageGuess === 'endgame' ? 'endgame' : `${a.stageGuess} game`), (a.gameMajor ?? 0) >= 2 ? (a.requiresSpaceAge ? 'Space Age' : 'no Space Age') : null, where].filter(
			(s): s is string => !!s
		)
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

<section aria-label="About this print" class="relative -mt-6 pt-8 pb-10">
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

	<div class="relative space-y-5">
		<a href="/" class="text-sm text-stone-300 hover:text-amber-300">← Search</a>
		<div class="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
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
								>{:else}unknown author{/if} · ★ {print.favorites} ·
							<a class="text-amber-400 underline" href={sourceUrl(print.id)} rel="external">original on factorioprints.com</a>
						</p>
					</div>
				</div>
				<div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-stone-200">
					<span>{contents}</span>
					{#if version && versionHref}
						<span aria-hidden="true" class="text-stone-600">·</span>
						<a
							href={versionHref}
							rel={searchRel(versionHref)}
							title="Search prints saved in Factorio {a.gameVersion}"
							class="rounded border border-sky-800/70 bg-sky-950/80 px-2 py-0.5 font-mono text-sm text-sky-300 hover:border-sky-600">{version}</a
						>
					{/if}
					{#if modded}
						<span title={a.mods.join(', ')} class="rounded border border-amber-600/60 bg-amber-950/70 px-2 py-0.5 text-sm font-semibold text-amber-300">{modded}</span>
					{/if}
					{#if notes.length}<span class="text-stone-400">{notes.join(' · ')}</span>{/if}
				</div>
				{#if main.length || groups.length}
					<MakesStrip {main} {groups} {icons} active={activeProduct} {onpick} tiles />
				{/if}
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
