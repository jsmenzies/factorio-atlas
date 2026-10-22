<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import { signalName } from '#lib/format.js';
	import type { IconKind, IconSet } from '#lib/icons.js';

	/** A sidebar list of names and counts (`name@quality` keys get a quality mark); long lists show 8 rows until opened. */
	let { title, kind, counts, icons }: { title: string; kind: IconKind; counts: Record<string, number>; icons: IconSet } = $props();

	const LIST_LIMIT = 8;
	let open = $state(false);
	const rows = $derived(Object.entries(counts));
</script>

<section>
	<h2 class="mb-2 text-xs font-semibold tracking-wide text-stone-400 uppercase">{title}</h2>
	<ul class="space-y-1 text-sm">
		{#each open ? rows : rows.slice(0, LIST_LIMIT) as [name, n] (name)}
			{@const [base, quality] = name.split('@')}
			<li class="flex items-center gap-2">
				<Icon {icons} {kind} name={base} label={signalName(base)} />
				<span class="min-w-0 flex-1 truncate">{signalName(base)}{#if quality}<span class="ml-1 text-xs text-amber-300">◆ {quality}</span>{/if}</span>
				<span class="text-stone-500">{n}</span>
			</li>
		{:else}
			<li class="text-stone-600">—</li>
		{/each}
	</ul>
	{#if rows.length > LIST_LIMIT}
		<button type="button" class="mt-1 text-xs text-stone-400 hover:text-amber-300" onclick={() => (open = !open)}>
			{open ? 'Show fewer' : `Show all ${rows.length}`}
		</button>
	{/if}
</section>
