<script lang="ts">
	import { formatDate } from '#lib/format.js';
	import type { PrintAnalysis } from '#lib/server/pipeline/analyze.js';
	import type { PagePrint } from '#lib/server/pipeline/print-doc.js';
	import { searchRel } from '#lib/search-seo.js';
	import { QUALITIES } from './CountSection.svelte';

	/**
	 * The print page's facts, beside every tab: version, what's in it, its size, quality, Space Age,
	 * where it can be built, stage, mods and dates. Rows with nothing to say are dropped; the About tab has the long form.
	 */
	let { print, analysis: a, size }: { print: PagePrint; analysis: PrintAnalysis; size: string | null } = $props();

	const modern = $derived((a.gameMajor ?? 0) >= 2);
	const PLANETS = ['nauvis', 'vulcanus', 'fulgora', 'gleba', 'aquilo'];
	const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
	// Where it can be built ("any planet", "Vulcanus only"); planets only mean something from 2.0 on.
	const where = $derived.by(() => {
		if (!modern || !a.placeableOn) return '';
		const planets = a.placeableOn.filter((p) => PLANETS.includes(p));
		if (planets.length === PLANETS.length) return 'any planet';
		if (!planets.length) return a.placeableOn.join(', ').replaceAll('-', ' ');
		return planets.length === 1 ? `${cap(planets[0])} only` : planets.map(cap).join(', ');
	});
	const stage = $derived(a.stageGuess ? (a.stageGuess === 'endgame' ? 'endgame' : `${a.stageGuess} game`) : '');
	const qualities = $derived(
		Object.keys(a.qualities)
			.sort((x, y) => QUALITIES.indexOf(x) - QUALITIES.indexOf(y))
			.join(', ')
	);
	const contents = $derived(
		a.bookCount ? `${a.blueprintCount} blueprint${a.blueprintCount === 1 ? '' : 's'} in ${a.bookCount} book${a.bookCount === 1 ? '' : 's'}` : '1 blueprint'
	);
	const versionHref = $derived(a.gameVersion ? `/?version=${encodeURIComponent(a.gameVersion)}` : null);
	const facts = $derived(
		(
			[
				['Claims', a.claimedVersions.join(', ')],
				['Contents', contents],
				['Size', size ?? ''],
				['Entities', a.entityCount.toLocaleString()],
				['Tiles', a.tileCount ? a.tileCount.toLocaleString() : ''],
				['Beacons', a.beacons ? a.beacons.toLocaleString() : ''],
				['Quality', modern ? qualities || 'normal only' : ''],
				['Space Age', modern ? (a.requiresSpaceAge ? 'required' : 'not needed') : ''],
				['Placeable', where],
				['Stage', stage],
				['Mods', a.mods.join(', ') || 'none detected'],
				['Posted', print.created_at ? formatDate(print.created_at) : ''],
				['Updated', print.updated_at && print.updated_at !== print.created_at ? formatDate(print.updated_at) : '']
			] as [string, string][]
		).filter(([, v]) => v)
	);
</script>

<!-- Its top border sits on the line under the tabs (PrintTabs is 3rem + a 2px underline; the line is its last pixel). -->
<aside class="lg:sticky lg:top-4 lg:mt-[calc(3rem+1px)] lg:self-start">
	<dl class="divide-y divide-stone-800 rounded-lg border border-stone-800 bg-stone-900/30 text-sm">
		<div class="flex justify-between gap-4 px-3 py-2">
			<dt class="text-stone-400">Saved in</dt>
			<dd class="text-right">
				{#if a.gameVersion && versionHref}
					<a href={versionHref} rel={searchRel(versionHref)} title="Search prints saved in Factorio {a.gameVersion}" class="hover:text-amber-300"
						>Factorio {a.gameVersion}</a
					>
				{:else}unknown{/if}
			</dd>
		</div>
		{#each facts as [k, v] (k)}
			<div class="flex justify-between gap-4 px-3 py-2">
				<dt class="shrink-0 text-stone-400">{k}</dt>
				<dd class="min-w-0 text-right break-words">{v}</dd>
			</div>
		{/each}
	</dl>
</aside>
