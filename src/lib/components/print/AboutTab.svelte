<script lang="ts">
	import RichText from '#lib/components/RichText.svelte';
	import ShotLightbox from '#lib/components/ShotLightbox.svelte';
	import { formatDate } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';
	import type { NodeAnalysis, PrintAnalysis } from '#lib/server/pipeline/analyze.js';
	import type { PagePrint } from '#lib/server/pipeline/print-doc.js';
	import { showsFavourites } from '#lib/print-id.js';
	import { plainText } from '#lib/richtext.js';
	import { NO_SHOT, type ShotView } from '#lib/screenshots.js';
	import { searchRel } from '#lib/search-seo.js';
	import { siteUrl, SOURCE_SITES, sourcesOfPrint, urlText } from '#lib/sources.js';

	/**
	 * Where a print comes from (the original, author, dates), the description saved inside the
	 * blueprint itself, everything the analyzer found in full, and its limits; the author's
	 * screenshot beside them, full size on a click (`shot`: shotView in #lib/screenshots.ts, so ours
	 * when copied, Imgur's while unknown, none when gone or removed).
	 */
	let {
		print,
		analysis: a,
		root,
		shot: view,
		icons
	}: { print: PagePrint; analysis: PrintAnalysis; root: NodeAnalysis | undefined; shot: ShotView; icons: IconSet } = $props();

	const shot = $derived(view.inline);
	// Every live source, credited first (#lib/sources.ts): the first is the one the title and author are from.
	const sources = $derived(
		sourcesOfPrint(print).map((s) => ({ site: s.site, name: SOURCE_SITES[s.site]?.name ?? s.site, url: siteUrl(s.site, s.site_id) }))
	);
	const alt = $derived(`Screenshot of ${plainText(String(print.title))}`);
	let lightbox = $state<ShotLightbox>();
	let shotFailed = $state(false);
	const list = (xs: string[] | null | undefined) => (xs ?? []).map((x) => x.replaceAll('-', ' ')).join(', ');
	const source = $derived(
		(
			[
				['Posted', print.created_at ? formatDate(print.created_at) : ''],
				['Updated', print.updated_at ? formatDate(print.updated_at) : ''],
				['Favourites', showsFavourites(print.source, print.id) ? `★ ${print.favorites.toLocaleString()}` : ''],
				['Saved in', a.gameVersion ? `Factorio ${a.gameVersion}` : 'unknown version'],
				['Claims', a.claimedVersions.join(', ')]
			] as [string, string][]
		).filter(([, v]) => v)
	);
	const wires = $derived(
		[a.wires.red && `${a.wires.red.toLocaleString()} red`, a.wires.green && `${a.wires.green.toLocaleString()} green`, a.wires.copper && `${a.wires.copper.toLocaleString()} copper`]
			.filter(Boolean)
			.join(' · ')
	);
	const found = $derived(
		(
			[
				['Space Age', a.requiresSpaceAge ? `required: ${list(a.spaceAgeEvidence)}` : (a.gameMajor ?? 0) >= 2 ? 'not needed' : ''],
				[
					'Quality',
					Object.entries(a.qualities)
						.map(([q, n]) => `${n.toLocaleString()} ${q}`)
						.join(' · ')
				],
				['Planets', list(a.planets)],
				['Placeable on', list(a.placeableOn)],
				['Limited by', list(a.surfaceEvidence)],
				['Mentions', list(a.claimedPlanets)],
				['Mods', a.mods.join(', ')],
				['Unknown names', a.unknownNames.join(', ')],
				['Elevated rails', a.usesElevatedRails ? 'yes' : ''],
				['Train stops', a.trainStops.join(', ')],
				['Wires', wires],
				['Combinators', a.combinators ? `${a.combinators.toLocaleString()}${a.signs ? ` (${a.signs.toLocaleString()} used as signs)` : ''}` : ''],
				['Books', a.bookCount > 1 ? `${a.bookCount} books, nested ${a.maxDepth} deep` : '']
			] as [string, string][]
		).filter(([, v]) => v)
	);
</script>

{#snippet facts(rows: [string, string][])}
	<dl class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[8rem_1fr]">
		{#each rows as [k, v] (k)}
			<dt class="text-stone-500">{k}</dt>
			<dd class="break-words text-stone-200">{v}</dd>
		{/each}
	</dl>
{/snippet}

<div class="grid gap-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
	<div class="grid content-start gap-8">
		<section class="space-y-3">
			<h3 class="border-b border-stone-800 pb-2 font-semibold text-stone-100">Source</h3>
			<p class="text-sm text-stone-300">
				{#if sources[0]?.url}From {sources[0].name}: <a class="text-amber-400 underline" href={sources[0].url} rel="external"
						>{urlText(sources[0].url)}</a
					>, by{:else if sources[0]?.site === 'upload'}Uploaded here by{:else}Posted by{/if}
				{#if print.author_id}<a class="text-stone-100 underline decoration-stone-500 hover:text-amber-300" href="/?author={print.author_id}" rel={searchRel(`/?author=${print.author_id}`)}
						>{print.author_name ?? 'unknown author'}</a
					>{:else if print.author_name}{print.author_name}{:else}an unknown author{/if}.
			</p>
			{#each sources.slice(1) as s, i (i)}
				<p class="text-sm text-stone-300">
					{#if s.url}Also on {s.name}: <a class="text-amber-400 underline" href={s.url} rel="external">{urlText(s.url)}</a
						>{:else if s.site === 'upload'}Also uploaded here.{:else}Also on {s.name}.{/if}
				</p>
			{/each}
			<p class="text-sm text-stone-400">
				Made it, or shouldn't it be here? <a class="text-amber-400 underline" href="/prints/{print.id}/remove" rel="nofollow">Request removal</a>
			</p>
			{@render facts(source)}
		</section>
	
		{#if root?.description}
			<section class="space-y-3">
				<h3 class="border-b border-stone-800 pb-2 font-semibold text-stone-100">Description saved in the {root.kind === 'blueprint_book' ? 'book' : 'blueprint'}</h3>
				<p class="text-sm leading-relaxed whitespace-pre-line text-stone-300"><RichText text={root.description} {icons} size={16} /></p>
			</section>
		{/if}
	
		{#if found.length}
			<section class="space-y-3">
				<h3 class="border-b border-stone-800 pb-2 font-semibold text-stone-100">What the analyzer found</h3>
				{@render facts(found)}
			</section>
		{/if}
	
		<section class="rounded-lg border border-dashed border-stone-700 p-3 text-xs text-stone-500">
			<h3 class="mb-1 font-semibold text-stone-400">Analyzer v{a.analyzerVersion} limits · game data {a.gameDataVersion}</h3>
			<ul class="list-disc space-y-0.5 pl-4">
				{#each a.limits as l (l)}<li>{l}</li>{/each}
			</ul>
		</section>
	</div>

	<figure class="space-y-2">
		{#if shot && !shotFailed}
			<button type="button" onclick={() => lightbox?.open()} class="block w-full overflow-hidden rounded-lg border border-stone-800 bg-stone-950" title="Show it full size">
				<img
					referrerpolicy={view.imgur ? 'no-referrer' : undefined}
					src={shot.src}
					width={shot.width}
					height={shot.height}
					{alt}
					loading="lazy"
					onerror={() => (shotFailed = true)}
					class="max-h-[32rem] w-full object-contain"
				/>
			</button>
			<figcaption class="flex items-baseline justify-between gap-3 text-sm text-stone-400">
				Author's screenshot
				<button type="button" onclick={() => lightbox?.open()} class="text-amber-400 hover:text-amber-300">Full size ↗</button>
			</figcaption>
		{:else}
			<div class="grid aspect-[4/3] place-items-center rounded-lg border border-dashed border-stone-700 text-sm text-stone-500">
				{print.image_id ? (NO_SHOT[view.state] ?? 'Screenshot unavailable') : 'No screenshot from the author'}
			</div>
		{/if}
	</figure>
</div>

{#if view.large && view.full}
	<ShotLightbox bind:this={lightbox} large={view.large} full={view.full} title={plainText(String(print.title))} imgur={view.imgur} />
{/if}
