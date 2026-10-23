<script lang="ts">
	import type { PrintAnalysis } from '#lib/server/pipeline/analyze.js';
	import { searchRel } from '#lib/search-seo.js';

	/** The print at a glance: version, Space Age, contents, planets, mods. Rows with nothing to say are dropped. */
	let { analysis: a }: { analysis: PrintAnalysis } = $props();

	const versionHref = (v: string) => `/?version=${encodeURIComponent(v)}`;
	const evidence = $derived(
		a.spaceAgeEvidence.slice(0, 3).join(', ') + (a.spaceAgeEvidence.length > 3 ? ` +${a.spaceAgeEvidence.length - 3}` : '')
	);
	// Belts, trains, power, defence and circuits have their own cards.
	const facts = $derived(
		(
			[
				['Saved in', a.gameVersion ? `Factorio ${a.gameVersion}` : 'unknown', a.gameVersion ? versionHref(a.gameVersion) : undefined],
				['Claims', a.claimedVersions.join(', ')],
				['Space Age', a.requiresSpaceAge ? `required (${evidence})` : 'not required'],
				['Stage', a.stageGuess ?? ''],
				['Contents', a.bookCount ? `${a.blueprintCount} blueprints in ${a.bookCount} book${a.bookCount === 1 ? '' : 's'}` : ''],
				['Entities', a.entityCount.toLocaleString()],
				['Beacons', a.beacons ? String(a.beacons) : ''],
				['Planets', a.planets.join(', ')],
				['Placeable on', a.placeableOn?.join(', ') ?? ''],
				['Mentions', a.claimedPlanets?.join(', ') ?? ''],
				['Mods', a.mods.join(', ') || 'none detected'],
				['Unknown names', a.unknownNames?.join(', ') ?? '']
			] as [string, string, string?][]
		).filter(([, v]) => v)
	);
</script>

<dl class="divide-y divide-stone-800 rounded-lg border border-stone-800 text-sm">
	{#each facts as [k, v, href] (k)}
		<div class="flex justify-between gap-4 px-3 py-2">
			<dt class="text-stone-400">{k}</dt>
			<dd class="text-right">
				{#if k === 'Claims'}
					{#each a.claimedVersions as cv, i (cv)}{i ? ', ' : ''}<a class="underline decoration-stone-600 hover:text-amber-300" href={versionHref(cv)} rel={searchRel(versionHref(cv))}>{cv}</a
						>{/each}
				{:else if href}<a class="underline decoration-stone-600 hover:text-amber-300" {href} rel={searchRel(href)} title="Search prints saved in this version">{v}</a>
				{:else}{v}{/if}
			</dd>
		</div>
	{/each}
</dl>
