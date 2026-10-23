<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import RichText from '#lib/components/RichText.svelte';
	import { imgurUrl, signalName } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';
	import type { PrintCard } from '#lib/server/queries.js';
	import { searchRel } from '#lib/search-seo.js';

	/**
	 * One search result: screenshot, title, author and counts as a link to the print, then its
	 * version, Space Age and render badges as filter links of their own, planets, mods and outputs.
	 */
	let {
		print: p,
		toggle,
		active,
		renderOnly,
		icons
	}: {
		print: PrintCard;
		/** Link to the current search with this filter value toggled. */
		toggle: (key: string, value: string) => string;
		/** Whether the current search has this filter value. */
		active: (key: string, value: string) => boolean;
		/** Whether the search is limited to prints with a render. */
		renderOnly: boolean;
		icons: IconSet;
	} = $props();
</script>

<li class="overflow-hidden rounded-lg border border-stone-800 bg-stone-900 hover:border-stone-600">
	<a href="/prints/{p.id}" class="block">
		{#if p.image_id}
			<div class="relative">
				<!-- Imgur's 320 px thumbnail, or its 640 px one where the card is wider or the screen sharper. -->
				<img
					referrerpolicy="no-referrer"
					src={imgurUrl(p.image_id, p.image_type)}
					srcset="{imgurUrl(p.image_id, p.image_type)} 320w, {imgurUrl(p.image_id, p.image_type, 'large')} 640w"
					sizes="(min-width: 1280px) 22rem, (min-width: 640px) 50vw, 100vw"
					alt=""
					loading="lazy"
					class="aspect-video w-full bg-stone-800 object-cover"
				/>
				{#if p.has_render}
					<span
						title="Has an in-game render"
						class="absolute top-2 right-2 grid size-7 place-items-center rounded-full bg-stone-950/80 text-amber-300 ring-1 ring-amber-500/60"
					>
						<svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
							<path d="m3.3 7 8.7 5 8.7-5" />
							<path d="M12 22V12" />
						</svg>
						<span class="sr-only">Has an in-game render</span>
					</span>
				{/if}
			</div>
		{/if}
		<div class="space-y-2 p-3">
			<h3 class="leading-snug font-medium text-stone-100"><RichText text={p.title} {icons} size={18} /></h3>
			<p class="text-xs text-stone-500">
				{p.author_name ?? 'unknown author'} · ★ {p.favorites} · {p.blueprint_count} blueprint{p.blueprint_count === 1 ? '' : 's'} · {p.entity_count} entities
			</p>
		</div>
	</a>
	<!-- Outside the card link: version and Space Age badges are filter links of their own. -->
	<div class="space-y-2 px-3 pb-3">
		<div class="flex flex-wrap gap-1 text-xs">
			{#if p.game_version}<a
					href={toggle('version', p.game_version)}
					rel={searchRel(toggle('version', p.game_version))}
					title="Filter by Factorio {p.game_version}"
					class="rounded bg-stone-800 px-1.5 py-0.5 hover:bg-stone-700 {active('version', p.game_version) ? 'ring-1 ring-amber-500' : ''}"
					>saved in {p.game_version}</a
				>{/if}
			{#each p.claimed_versions as v (v)}<a
					href={toggle('version', v)}
					rel={searchRel(toggle('version', v))}
					title="Filter by Factorio {v}"
					class="rounded bg-sky-900/50 px-1.5 py-0.5 text-sky-300 hover:bg-sky-800/60 {active('version', v) ? 'ring-1 ring-amber-500' : ''}"
					>{v}</a
				>{/each}
			{#if p.requires_space_age}<a
					href={toggle('spaceAge', 'yes')}
					rel={searchRel(toggle('spaceAge', 'yes'))}
					title="Filter by Space Age"
					class="rounded bg-violet-900/60 px-1.5 py-0.5 text-violet-300 hover:bg-violet-800/60 {active('spaceAge', 'yes') ? 'ring-1 ring-amber-500' : ''}"
					>Space Age</a
				>{/if}
			{#if p.has_render && !p.image_id}<a
					href={toggle('render', '1')}
					rel={searchRel(toggle('render', '1'))}
					title="Only prints with a render"
					class="rounded bg-amber-900/40 px-1.5 py-0.5 text-amber-300 hover:bg-amber-800/50 {renderOnly ? 'ring-1 ring-amber-500' : ''}"
					>render</a
				>{/if}
			{#each p.planets as pl (pl)}<span class="rounded bg-emerald-900/50 px-1.5 py-0.5 text-emerald-300">{pl}</span>{/each}
			{#each p.mods as m (m)}<span class="rounded bg-rose-900/50 px-1.5 py-0.5 text-rose-300">{m}</span>{/each}
		</div>
		{#if p.outputs.length}
			<p class="flex flex-wrap items-center gap-1 text-xs text-stone-400">
				{#each p.outputs.slice(0, 8) as o (o)}
					<Icon {icons} signal={o} label={signalName(o)} size={20} />
				{/each}
				{#if p.outputs.length > 8}<span>+{p.outputs.length - 8}</span>{/if}
			</p>
		{/if}
	</div>
</li>
