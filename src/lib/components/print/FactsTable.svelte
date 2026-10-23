<script lang="ts">
	import type { PrintAnalysis } from '#lib/server/pipeline/analyze.js';

	/**
	 * The details the header (PrintHero) has no room for: what needs Space Age, entities, beacons,
	 * planets, mods in full, unknown names. Rows with nothing to say are dropped.
	 */
	let { analysis: a }: { analysis: PrintAnalysis } = $props();

	const evidence = $derived(
		a.spaceAgeEvidence.slice(0, 3).join(', ') + (a.spaceAgeEvidence.length > 3 ? ` +${a.spaceAgeEvidence.length - 3}` : '')
	);
	// Belts, trains, power, defence and circuits have their own cards.
	const facts = $derived(
		(
			[
				['Space Age', a.requiresSpaceAge ? `required (${evidence})` : ''],
				['Entities', a.entityCount.toLocaleString()],
				['Beacons', a.beacons ? String(a.beacons) : ''],
				['Planets', a.planets.join(', ')],
				['Placeable on', a.placeableOn?.join(', ') ?? ''],
				['Mentions', a.claimedPlanets?.join(', ') ?? ''],
				['Mods', a.mods.join(', ') || 'none detected'],
				['Unknown names', a.unknownNames?.join(', ') ?? '']
			] as [string, string][]
		).filter(([, v]) => v)
	);
</script>

<dl class="divide-y divide-stone-800 rounded-lg border border-stone-800 text-sm">
	{#each facts as [k, v] (k)}
		<div class="flex justify-between gap-4 px-3 py-2">
			<dt class="text-stone-400">{k}</dt>
			<dd class="text-right">{v}</dd>
		</div>
	{/each}
</dl>
