<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import Rate from '#lib/components/Rate.svelte';
	import RichText from '#lib/components/RichText.svelte';
	import ShotLightbox from '#lib/components/ShotLightbox.svelte';
	import { describeBook, describeSetup, infraCards, pageTitle, type MadeItem } from '#lib/describe.js';
	import { signalName } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';
	import type { NodeAnalysis, PrintAnalysis, Role } from '#lib/server/pipeline/analyze.js';
	import type { PagePrint } from '#lib/server/pipeline/print-doc.js';
	import { plainText } from '#lib/richtext.js';
	import type { ShotView } from '#lib/screenshots.js';
	import type { AuthorTag } from '#lib/tags.js';
	import type { PageThumb } from '#lib/viewer/thumbs.js';
	import { countRows } from './CountSection.svelte';
	import Description from './Description.svelte';
	import PrintChips from './PrintChips.svelte';
	import type { TabId } from './PrintTabs.svelte';

	/**
	 * The first tab: the print at a glance, one row per thing it does (book, makes, takes, built with,
	 * belts, trains, power, defence, circuits, entities, tags); the rows with a tab of their own are
	 * labelled with a link to it (Pages, Produces, Inputs, Entities). A preview of the render beside it (the author's screenshot when there's no render), and
	 * the author's description under both.
	 */
	let {
		print,
		analysis: a,
		shot: view,
		single,
		summary,
		main,
		more,
		tags,
		preview,
		descriptionHtml,
		descriptionLong,
		activeRole,
		onrole,
		ontab,
		icons
	}: {
		print: PagePrint;
		analysis: PrintAnalysis;
		/** The author's screenshot (shotView in #lib/screenshots.ts): ours, Imgur's while unknown, or none. */
		shot: ShotView;
		single: NodeAnalysis | null;
		/** A line saying what a blueprint that makes nothing is for. */
		summary: string | null;
		main: MadeItem[];
		/** How many more items it makes, on the Produces tab. */
		more: number;
		tags: AuthorTag[];
		/** A rendered page's overview image: the selected page's, else the biggest one's. */
		preview: { url: string; thumb: PageThumb | undefined; page: NodeAnalysis; index: number; total: number; fullScreen: string } | null;
		descriptionHtml: string;
		descriptionLong: boolean;
		activeRole: Role | null;
		/** In a book, role chips show that role's pages. */
		onrole?: (role: Role) => void;
		ontab: (tab: TabId) => void;
		icons: IconSet;
	} = $props();

	const TAKES_LIMIT = 8;
	/** The highest quality above normal each product is crafted at, for its badge. */
	const bestQuality = $derived(
		new Map(
			countRows(a.productsByQuality ?? {}).flatMap((r) => {
				const best = r.parts.at(-1)?.quality;
				return best && best !== 'normal' ? [[r.name, best]] : [];
			})
		)
	);
	const takes = $derived(a.inputs.map((s) => ({ signal: s, rate: single && single.rates[s] < 0 ? -single.rates[s] : null })));
	const setup = $derived(describeSetup(a));
	const machines = $derived(Object.keys(a.byCategory.production ?? {}).filter((n) => !/beacon/.test(n)).slice(0, 3));
	const cards = $derived(infraCards(a));
	const kinds = $derived(Object.keys(a.entities).length);
	const higher = $derived(Object.entries(a.qualities));
	const shot = $derived(view.inline);
	let lightbox = $state<ShotLightbox>();
	const ROW = 'grid gap-x-4 gap-y-1 py-3 sm:grid-cols-[6.5rem_1fr] sm:items-center';
	let shotFailed = $state(false);
	/** The preview's thumbnails failed (a cached page naming replaced files): the overview alone, then nothing. */
	let previewFailed = $derived.by((): 'thumb' | 'all' | null => (void preview?.url, null));
	const previewThumb = $derived(previewFailed ? undefined : preview?.thumb);
</script>

{#snippet go(tab: TabId, label: string)}
	<button type="button" onclick={() => ontab(tab)} class="text-left text-sm whitespace-nowrap text-amber-400 hover:text-amber-300">{label} →</button>
{/snippet}

<div class="space-y-8">
	<div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
		<dl class="self-start divide-y divide-stone-800 border-y border-stone-800 text-sm">
			{#if summary}
				<div class={ROW}>
					<dt class="text-stone-400">Blueprint</dt>
					<dd class="text-stone-200">{summary}</dd>
				</div>
			{/if}

			{#if !single}
				<div class={ROW}>
					<dt>{@render go('pages', 'Pages')}</dt>
					<dd class="text-stone-200">{describeBook(a)}</dd>
				</div>
			{/if}

			{#if main.length}
				<div class={ROW}>
					<dt>{@render go('produces', 'Produces')}</dt>
					<dd class="flex flex-wrap items-center gap-x-4 gap-y-2">
						{#each main as m (m.signal)}
							<span class="flex items-center gap-1.5" title="{signalName(m.signal)}{m.rate ? `: ${m.claimed ? 'claimed' : 'calculated at full speed'}` : ''}">
								<span class="relative inline-block leading-none">
									<Icon {icons} signal={m.signal} label={signalName(m.signal)} size={28} />
									{#if bestQuality.get(m.signal)}<span class="absolute -bottom-0.5 -left-0.5"
											><Icon {icons} kind="quality" name={bestQuality.get(m.signal)} label="" size={12} /></span
										>{/if}
								</span>
								{#if m.rate}<span class="text-base text-stone-100 tabular-nums">{m.claimed ? '' : '≈ '}<Rate value={m.rate} /></span>{/if}
							</span>
						{/each}
						{#if more}{@render go('produces', `+${more} more`)}{/if}
					</dd>
				</div>
			{/if}

			{#if takes.length}
				<div class={ROW}>
					<dt>{@render go('inputs', 'Inputs')}</dt>
					<dd class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
						{#each takes.slice(0, TAKES_LIMIT) as t (t.signal)}
							<span class="flex items-center gap-1 text-stone-300" title={signalName(t.signal)}>
								<Icon {icons} signal={t.signal} label={signalName(t.signal)} size={22} />
								{#if t.rate}<span class="text-stone-400 tabular-nums"><Rate value={t.rate} /></span>{:else if takes.length <= 4}{signalName(t.signal)}{/if}
							</span>
						{/each}
						{#if takes.length > TAKES_LIMIT}{@render go('inputs', `+${takes.length - TAKES_LIMIT} more`)}{/if}
					</dd>
				</div>
			{/if}

			{#if setup}
				<div class={ROW}>
					<dt>{@render go('entities', 'Entities')}</dt>
					<dd class="flex items-center gap-3 text-stone-200">
						<span class="flex shrink-0 gap-1">{#each machines as n (n)}<Icon {icons} kind="entity" name={n} label={signalName(n)} size={22} />{/each}</span>
						<span>{setup}</span>
					</dd>
				</div>
			{/if}

			{#each cards as card (card.cat)}
				<div class={ROW}>
					<dt class="text-stone-400">{card.title}</dt>
					<dd class="flex items-center gap-3 text-stone-200">
						<span class="flex shrink-0 gap-1">
							{#each Object.keys(a.byCategory[card.cat] ?? {}).slice(0, 3) as n (n)}<Icon {icons} kind="entity" name={n} label={signalName(n)} size={22} />{/each}
						</span>
						<span><RichText text={card.headline} {icons} size={16} /></span>
					</dd>
				</div>
			{/each}

			<div class={ROW}>
				<dt>{#if setup}<span class="text-stone-400">Entities</span>{:else}{@render go('entities', 'Entities')}{/if}</dt>
				<dd class="flex flex-wrap items-center gap-x-3 gap-y-1">
					<span class="text-base font-semibold text-stone-100 tabular-nums">{a.entityCount.toLocaleString()}</span>
					<span class="text-stone-300">
						{kinds} kinds{a.blueprintCount > 1 ? ` in ${a.blueprintCount} blueprints` : ''}{single?.width && single.height ? ` · ${single.width}×${single.height} tiles` : ''}
					</span>
					{#each higher as [q, n] (q)}
						<span class="flex items-center gap-1 text-stone-300" title="{n.toLocaleString()} at {q} quality (entities and modules)">
							<Icon {icons} kind="quality" name={q} label={signalName(q)} size={16} />{n.toLocaleString()}
						</span>
					{/each}
				</dd>
			</div>

			{#if Object.keys(a.roles).length || tags.length}
				<div class={ROW}>
					<dt class="text-stone-400">{tags.length ? 'Tags' : 'Kind'}</dt>
					<dd><PrintChips roles={a.roles} {tags} {activeRole} {onrole} /></dd>
				</div>
			{/if}
		</dl>

		{#if preview && previewFailed !== 'all'}
			{@const t = pageTitle(preview.page)}
			<figure class="space-y-2">
				<div class="relative overflow-hidden rounded-lg border border-stone-800 bg-stone-950">
					<button type="button" onclick={() => ontab('pages')} class="block w-full" title="Open the zoomable render">
						<img
							src={preview.url}
							srcset={previewThumb?.srcset}
							sizes={previewThumb ? '(min-width: 1280px) 22rem, 100vw' : undefined}
							onerror={() => (previewFailed = previewThumb ? 'thumb' : 'all')}
							alt="In-game render of {plainText(t.text)}"
							class="aspect-[4/3] w-full object-contain p-3"
						/>
					</button>
					<a
						href={preview.fullScreen}
						class="absolute top-2 right-2 rounded bg-stone-900/90 px-2 py-1 text-xs text-stone-300 ring-1 ring-stone-700 hover:text-amber-300">Full screen ⤢</a
					>
				</div>
				<figcaption class="flex items-baseline justify-between gap-3 text-sm">
					<span class="min-w-0 truncate text-stone-400">
						{#if preview.total > 1}Page {preview.index + 1} of {preview.total} ·&nbsp;{/if}<span class={t.derived ? 'italic' : ''}
							><RichText text={t.text} {icons} size={16} /></span
						>
					</span>
					{@render go('pages', preview.total > 1 ? 'All pages' : 'Zoom in')}
				</figcaption>
			</figure>
		{:else if shot && !shotFailed}
			<figure class="space-y-2">
				<button type="button" onclick={() => lightbox?.open()} class="block w-full overflow-hidden rounded-lg border border-stone-800 bg-stone-950" title="Show it full size">
					<img
						referrerpolicy={view.imgur ? 'no-referrer' : undefined}
						src={shot.src}
						width={shot.width}
						height={shot.height}
						alt="Screenshot of {plainText(String(print.title))}"
						loading="lazy"
						onerror={() => (shotFailed = true)}
						class="aspect-[4/3] w-full object-cover"
					/>
				</button>
				<figcaption class="text-sm text-stone-400">Author's screenshot · no in-game render for this print yet</figcaption>
			</figure>
		{/if}
	</div>

	{#if descriptionHtml}
		<Description html={descriptionHtml} long={descriptionLong} />
	{/if}
</div>

{#if (!preview || previewFailed === 'all') && view.large && view.full}
	<ShotLightbox bind:this={lightbox} large={view.large} full={view.full} title={plainText(String(print.title))} imgur={view.imgur} />
{/if}
