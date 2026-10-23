<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import { signalName } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';
	import { searchRel } from '#lib/search-seo.js';

	type Facet = { value: string; n: number };

	/**
	 * The search page's sidebar: what prints make and are built with, their modules, the qualities in
	 * them, game versions and features, each a filter link.
	 */
	let {
		makes,
		uses,
		modules,
		qualities,
		versions,
		makesLabel,
		usesLabel,
		toggle,
		active,
		icons
	}: {
		makes: Facet[];
		uses: Facet[];
		modules: Facet[];
		/** Matches with something at each quality level, lowest first. */
		qualities: Facet[];
		versions: Facet[];
		makesLabel: (signal: string) => string;
		usesLabel: (signal: string) => string;
		/** Link to the current search with this filter value toggled. */
		toggle: (key: string, value: string) => string;
		/** Whether the current search has this filter value. */
		active: (key: string, value: string) => boolean;
		icons: IconSet;
	} = $props();

	const FEATURES = [
		['spaceAge', 'no', 'No Space Age needed'],
		['spaceAge', 'yes', 'Space Age'],
		['circuits', '1', 'Uses circuits'],
		['trains', '1', 'Uses trains']
	] as const;
</script>

<!-- `icon`: the signal to draw for a value, when the list has icons. -->
{#snippet facet(title: string, key: string, items: Facet[], label: (v: string) => string, icon?: (v: string) => string)}
	<section>
		<h2 class="mb-2 text-xs font-semibold tracking-wide text-stone-400 uppercase">{title}</h2>
		{#if items.length === 0}
			<p class="text-stone-600">—</p>
		{/if}
		<ul class="space-y-0.5">
			{#each items as f (f.value)}
				{@const href = toggle(key, f.value)}
				<li>
					<a
						{href}
						rel={searchRel(href)}
						class="flex items-center gap-2 rounded px-2 py-0.5 hover:bg-stone-800 {active(key, f.value) ? 'bg-amber-500/15 text-amber-300' : ''}"
					>
						{#if icon}
							<Icon {icons} signal={icon(f.value)} label={label(f.value)} size={18} />
						{/if}
						<span class="min-w-0 flex-1 truncate">{label(f.value)}</span><span class="text-stone-500">{f.n}</span>
					</a>
				</li>
			{/each}
		</ul>
	</section>
{/snippet}

<aside class="space-y-6 text-sm">
	{@render facet('Makes', 'makes', makes.slice(0, 25), makesLabel, (v) => v)}
	{@render facet('Built with', 'uses', uses.slice(0, 25), usesLabel, (v) => v)}
	{#if modules.length}{@render facet('Modules', 'module', modules, signalName, (v) => `item:${v}`)}{/if}
	{@render facet('Quality in the print', 'quality', qualities, signalName, (v) => `quality:${v}`)}
	{@render facet('Game version', 'version', versions, (v) => v)}

	<section>
		<h2 class="mb-2 text-xs font-semibold tracking-wide text-stone-400 uppercase">Features</h2>
		<ul class="space-y-0.5">
			{#each FEATURES as [k, v, l] (k + v)}
				{@const href = toggle(k, v)}
				<li>
					<a {href} rel={searchRel(href)} class="block rounded px-2 py-0.5 hover:bg-stone-800 {active(k, v) ? 'bg-amber-500/15 text-amber-300' : ''}">{l}</a>
				</li>
			{/each}
		</ul>
	</section>
</aside>
