<script lang="ts">
	import type { DetailGroup } from '#lib/sync.js';
	import { int } from '../metrics.js';

	/** One step's recorded figures, as label/value rows in a panel (a group per title): the Update tab's step strip. */
	let { details }: { details: DetailGroup[] } = $props();
</script>

<div class="mt-1.5 grid gap-x-8 gap-y-2 rounded-md border border-stone-800 bg-stone-950/60 px-3 py-2 {details.length > 1 ? 'max-w-2xl sm:grid-cols-2' : 'max-w-sm'}">
	{#each details as g, gi (gi)}
		<div class="min-w-0">
			{#if g.title}<p class="truncate text-xs font-semibold text-stone-400" title={g.title}>{g.title}</p>{/if}
			<dl class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 text-sm">
				{#each g.rows as r, ri (ri)}
					{#if r.muted}
						<dd class="col-span-full truncate text-xs text-stone-500" title={String(r.value)}>{r.label}: {r.value}</dd>
					{:else if typeof r.value === 'string' && r.value.length > 32}
						<dt class="col-span-full text-stone-400">{r.label}</dt>
						<dd class="col-span-full break-words {r.tone === 'bad' ? 'text-rose-300' : r.tone === 'warn' ? 'text-amber-200' : 'text-stone-200'}">{r.value}</dd>
					{:else}
						<dt class="truncate text-stone-400">{r.label}</dt>
						<dd class="text-right tabular-nums {r.tone === 'bad' ? 'text-rose-300' : r.tone === 'warn' ? 'text-amber-200' : 'text-stone-200'}">
							{typeof r.value === 'number' ? int(r.value) : r.value}
						</dd>
					{/if}
				{/each}
			</dl>
		</div>
	{/each}
</div>
