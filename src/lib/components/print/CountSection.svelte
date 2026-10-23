<script lang="ts" module>
	import { QUALITY_LEVELS } from '#lib/quality.js';

	/** The game's quality order; a modded quality sorts after these. */
	export const QUALITIES: readonly string[] = ['normal', ...QUALITY_LEVELS];
	const rank = (q: string) => (QUALITIES.includes(q) ? QUALITIES.indexOf(q) : QUALITIES.length);

	export interface CountRow {
		name: string;
		total: number;
		/** How many at each quality, lowest first. */
		parts: { quality: string; n: number }[];
	}

	/**
	 * `name@quality` counts (plain `name` is normal quality) as one row per name, largest first.
	 * With `only`, just that quality's counts.
	 */
	export const countRows = (counts: Record<string, number>, only: string | null = null): CountRow[] => {
		const rows = new Map<string, CountRow>();
		for (const [key, n] of Object.entries(counts)) {
			const [name, quality = 'normal'] = key.split('@');
			if (only && quality !== only) continue;
			const row = rows.get(name) ?? { name, total: 0, parts: [] };
			row.total += n;
			row.parts.push({ quality, n });
			rows.set(name, row);
		}
		for (const row of rows.values()) row.parts.sort((x, y) => rank(x.quality) - rank(y.quality));
		return [...rows.values()].sort((x, y) => y.total - x.total || x.name.localeCompare(y.name));
	};
</script>

<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import RichText from '#lib/components/RichText.svelte';
	import { signalName } from '#lib/format.js';
	import type { IconKind, IconSet } from '#lib/icons.js';
	import { plainText } from '#lib/richtext.js';

	/**
	 * One group of the Entities tab (Belts, Power, Modules, Tiles…): a heading with its summary, then
	 * a line per name and quality with its count, the game's quality badge on the icon and the quality's name above normal.
	 * A name's lines sit together, highest quality first. Long groups show `limit` names until opened.
	 */
	let {
		title,
		note = '',
		rows,
		kind,
		icons,
		limit = 8
	}: { title: string; note?: string; rows: CountRow[]; kind: IconKind; icons: IconSet; limit?: number } = $props();

	let open = $state(false);
	const shown = $derived(open ? rows : rows.slice(0, limit));
</script>

<section class="break-inside-avoid pb-6">
	<h3 class="flex items-baseline justify-between gap-3 border-b border-stone-800 pb-2">
		<span class="shrink-0 font-semibold text-stone-100">{title}</span>
		{#if note}<span class="min-w-0 truncate text-right text-xs text-stone-400" title={plainText(note)}><RichText text={note} {icons} size={14} /></span>{/if}
	</h3>
	<ul class="mt-1.5 text-sm">
		<!-- One line per name and quality, highest quality first, a name's lines together. -->
		{#each shown as row (row.name)}
			{#each row.parts.toReversed() as p (p.quality)}
				<li class="flex items-center gap-2.5 py-1">
					<span class="relative inline-block shrink-0">
						<Icon {icons} {kind} name={row.name} label={signalName(row.name)} size={24} />
						{#if p.quality !== 'normal'}
							<span class="absolute -bottom-0.5 -left-0.5 leading-none">
								<Icon {icons} kind="quality" name={p.quality} label={signalName(p.quality)} size={11} />
							</span>
						{/if}
					</span>
					<span class="min-w-0 flex-1 truncate text-stone-200"
						>{signalName(row.name)}{#if p.quality !== 'normal'}<span class="ml-1.5 text-xs text-stone-500">{p.quality}</span>{/if}</span
					>
					<span class="w-14 shrink-0 text-right text-stone-300 tabular-nums">{p.n.toLocaleString()}</span>
				</li>
			{/each}
		{/each}
	</ul>
	{#if rows.length > limit}
		<button type="button" class="mt-1 text-xs text-stone-400 hover:text-amber-300" onclick={() => (open = !open)}>
			{open ? 'Show fewer' : `Show all ${rows.length}`}
		</button>
	{/if}
</section>
