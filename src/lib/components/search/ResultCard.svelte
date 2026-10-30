<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import RenderIcon from '#lib/components/RenderIcon.svelte';
	import RichText from '#lib/components/RichText.svelte';
	import { signalName } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';
	import { showsFavourites } from '#lib/print-id.js';
	import type { CardImage } from '#lib/screenshots.js';
	import type { PrintCard } from '#lib/server/queries.js';
	import { searchRel } from '#lib/search-seo.js';

	/**
	 * One search result: picture, title, author and counts as a link to the print, then its version,
	 * Space Age and render badges as filter links of their own, planets, mods and outputs. The picture
	 * (cardImage in #lib/screenshots.ts): our copy of the author's screenshot; Imgur's while ours isn't
	 * there yet; else the render thumbnail of its cover page; else none.
	 */
	let {
		print: p,
		eager = false,
		toggle,
		active,
		renderOnly,
		icons
	}: {
		print: PrintCard & { image: CardImage | null };
		/** Load the picture at once: cards in the first row. The rest load as they near the screen. */
		eager?: boolean;
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
		{#if p.image}
			<div class="relative">
				<!-- 320, 640 or 960 px wide, whichever suits the card's width and the screen. -->
				<img
					referrerpolicy={p.image.kind === 'imgur' ? 'no-referrer' : undefined}
					src={p.image.src}
					srcset={p.image.srcset}
					sizes="(min-width: 1280px) 22rem, (min-width: 640px) 50vw, 100vw"
					width={p.image.width}
					height={p.image.height}
					alt=""
					loading={eager ? 'eager' : 'lazy'}
					class="aspect-video w-full bg-stone-800 {p.image.kind === 'render' ? 'object-contain' : 'object-cover'}"
				/>
				{#if p.has_render}
					<span
						title="Has an in-game render"
						class="absolute top-2 right-2 grid size-7 place-items-center rounded-full bg-stone-950/80 text-amber-300 ring-1 ring-amber-500/60"
					>
						<RenderIcon />
						<span class="sr-only">Has an in-game render</span>
					</span>
				{/if}
			</div>
		{/if}
		<div class="space-y-2 p-3">
			<h3 class="leading-snug font-medium text-stone-100"><RichText text={p.title} {icons} size={18} /></h3>
			<p class="text-xs text-stone-500">
				{p.author_name ?? 'unknown author'}{#if showsFavourites(p.source, p.id)} · ★ {p.favorites}{/if} · {p.blueprint_count} blueprint{p.blueprint_count === 1 ? '' : 's'} · {p.entity_count} entities
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
			{#if p.has_render && !p.image}<a
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
