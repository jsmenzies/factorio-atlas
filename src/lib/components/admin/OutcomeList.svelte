<script lang="ts" generics="K extends string">
	import { int, percent } from './metrics.js';

	/** Each outcome's count and share of the pages or prints done, with what it means. `columns`: the grid's columns from lg up. */
	let {
		run,
		outcomes,
		columns
	}: {
		run: Record<K, number> & { done: number };
		outcomes: { key: K; label: string; hint: string; color: string }[];
		columns: string;
	} = $props();
</script>

<dl class="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 {columns}">
	{#each outcomes as o (o.key)}
		{@const n = run[o.key]}
		<div class="flex items-start gap-2 {n === 0 ? 'opacity-45' : ''}">
			<span class="mt-1.5 size-2.5 shrink-0 rounded-sm {o.color}" aria-hidden="true"></span>
			<div class="min-w-0">
				<dt class="text-stone-200">
					{o.label}
					<span class="ml-1 text-stone-100 tabular-nums">{int(n)}</span>
					{#if n > 0 && run.done > 0}<span class="text-xs text-stone-500"> {percent(n, run.done)}</span>{/if}
				</dt>
				<dd class="text-xs text-stone-500">{o.hint}</dd>
			</div>
		</div>
	{/each}
</dl>
