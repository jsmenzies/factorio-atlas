<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import { signalName } from '#lib/format.js';
	import type { IconKind, IconSet } from '#lib/icons.js';
	import { QUALITY_LEVELS } from '#lib/quality.js';

	/**
	 * A sidebar list of names and counts. `name@quality` keys come first, lowest quality to highest,
	 * with the game's quality badge on their icon; normal-quality rows follow. Each part shows 8 rows
	 * until opened.
	 */
	let { title, kind, counts, icons }: { title: string; kind: IconKind; counts: Record<string, number>; icons: IconSet } = $props();

	const LIST_LIMIT = 8;
	/** The game's quality order; a modded quality sorts after these. */
	const QUALITIES: readonly string[] = QUALITY_LEVELS;
	const rank = (q: string) => (QUALITIES.includes(q) ? QUALITIES.indexOf(q) : QUALITIES.length);

	type Row = { key: string; name: string; quality: string | null; n: number };
	const rows = $derived(
		Object.entries(counts).map(([key, n]): Row => {
			const [name, quality] = key.split('@');
			return { key, name, quality: quality ?? null, n };
		})
	);
	// Counts arrive sorted by count; a stable sort keeps that order within each quality.
	const higher = $derived(rows.filter((r) => r.quality).sort((a, b) => rank(a.quality!) - rank(b.quality!)));
	const normal = $derived(rows.filter((r) => !r.quality));
	const parts = $derived(
		[
			{ id: 'higher', label: 'Higher quality', rows: higher },
			{ id: 'normal', label: 'Normal quality', rows: normal }
		].filter((p) => p.rows.length)
	);
	let open = $state<Record<string, boolean>>({});
</script>

<section>
	<h2 class="mb-2 text-xs font-semibold tracking-wide text-stone-400 uppercase">{title}</h2>
	{#each parts as part (part.id)}
		{#if parts.length > 1}
			<h3 class="mt-3 mb-1.5 flex items-center gap-2 text-xs text-stone-500 first-of-type:mt-0 after:flex-1 after:border-t after:border-stone-800">
				{part.label}
			</h3>
		{/if}
		<ul class="space-y-1 text-sm">
			{#each open[part.id] ? part.rows : part.rows.slice(0, LIST_LIMIT) as row (row.key)}
				<li class="flex items-center gap-2">
					<span class="relative inline-block shrink-0">
						<Icon {icons} {kind} name={row.name} label={signalName(row.name)} />
						{#if row.quality}
							<span class="absolute -bottom-0.5 -left-0.5 leading-none">
								<Icon {icons} kind="quality" name={row.quality} label={signalName(row.quality)} size={10} />
							</span>
						{/if}
					</span>
					<span class="min-w-0 flex-1 truncate">{signalName(row.name)}</span>
					<span class="text-stone-500">{row.n.toLocaleString()}</span>
				</li>
			{/each}
		</ul>
		{#if part.rows.length > LIST_LIMIT}
			<button type="button" class="mt-1 text-xs text-stone-400 hover:text-amber-300" onclick={() => (open[part.id] = !open[part.id])}>
				{open[part.id] ? 'Show fewer' : `Show all ${part.rows.length}`}
			</button>
		{/if}
	{:else}
		<p class="text-sm text-stone-600">—</p>
	{/each}
</section>
