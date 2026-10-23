<script lang="ts">
	import BlueprintIcons from '#lib/components/BlueprintIcons.svelte';
	import RichText from '#lib/components/RichText.svelte';
	import { ROLE_CLASS, ROLE_LABEL } from '#lib/describe.js';
	import { sourceUrl } from '#lib/format.js';
	import type { IconSet } from '#lib/icons.js';
	import type { NodeAnalysis, Role } from '#lib/server/pipeline/analyze.js';
	import type { PrintDoc } from '#lib/server/pipeline/print-doc.js';
	import type { AuthorTag } from '#lib/tags.js';
	import { searchRel } from '#lib/search-seo.js';

	/**
	 * The print's icons, title, author and source link, then its role chips (in a book, buttons
	 * that filter the page grid) and the author tags that add something to the analysis.
	 */
	let {
		print,
		title,
		root,
		roles,
		tags,
		single,
		activeRole,
		onrole,
		copyLabel,
		oncopy,
		icons
	}: {
		print: PrintDoc['print'];
		title: string;
		root: NodeAnalysis | undefined;
		roles: Record<string, number>;
		tags: AuthorTag[];
		single: boolean;
		/** The role the page grid is filtered to, if any. */
		activeRole: Role | null;
		onrole: (role: Role) => void;
		copyLabel: string;
		oncopy: () => void;
		icons: IconSet;
	} = $props();

	// The first few tags show, the rest on request.
	const TAG_LIMIT = 4;
	let showAllTags = $state(false);
</script>

<header class="space-y-2">
	<div class="flex items-center gap-3">
		{#if root?.icons.length}<BlueprintIcons {icons} signals={root.icons} kind={root.kind} size={48} />{/if}
		<h1 class="text-2xl font-semibold text-stone-100"><RichText text={title} {icons} size={26} /></h1>
	</div>
	<p class="text-sm text-stone-400">
		by {print.author_name ?? 'unknown author'} · ★ {print.favorites} ·
		<a class="text-amber-400 underline" href={sourceUrl(print.id)} rel="external">original on factorioprints.com</a>
	</p>
	<!-- On phones the sidebar (and its copy button) sits at the very bottom. -->
	<button onclick={oncopy} class="w-full rounded bg-amber-500 px-4 py-2 font-medium text-stone-950 hover:bg-amber-400 lg:hidden">
		{copyLabel}
	</button>
	<div class="flex flex-wrap items-center gap-1 text-xs">
		<!-- In a book, role chips filter the page grid below. -->
		{#each Object.entries(roles) as [r, k] (r)}
			{@const role = r as Role}
			{#if single}
				<span class="rounded px-1.5 py-0.5 {ROLE_CLASS[role]}">{ROLE_LABEL[role]}</span>
			{:else}
				<button
					type="button"
					onclick={() => onrole(role)}
					aria-pressed={activeRole === role}
					title="Show only {ROLE_LABEL[role].toLowerCase()} pages"
					class="rounded px-1.5 py-0.5 {ROLE_CLASS[role]} {activeRole === role ? 'ring-1 ring-amber-400' : ''}">{ROLE_LABEL[role]} · {k}</button
				>
			{/if}
		{/each}
		{#each showAllTags ? tags : tags.slice(0, TAG_LIMIT) as t (t.raw)}<a
				href="/?{t.param.key}={encodeURIComponent(t.param.value)}"
				rel={searchRel(`/?${t.param.key}=${encodeURIComponent(t.param.value)}`)}
				title="Author tag {t.raw}: search for it"
				class="rounded bg-stone-800 px-1.5 py-0.5 text-stone-300 hover:bg-stone-700 hover:text-amber-300"
				><span class="text-stone-500">{t.category}</span> {t.label}</a
			>{/each}
		{#if tags.length > TAG_LIMIT}
			<button type="button" class="rounded px-1.5 py-0.5 text-stone-400 hover:text-amber-300" onclick={() => (showAllTags = !showAllTags)}>
				{showAllTags ? 'fewer' : `+${tags.length - TAG_LIMIT} tags`}
			</button>
		{/if}
	</div>
</header>
