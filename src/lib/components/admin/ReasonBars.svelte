<script lang="ts">
	import { int } from './metrics.js';

	/** Counts by reason (failures, skips), each with a bar against the largest. `bar`: the bars' colour class. */
	let { reasons, bar }: { reasons: [string, number][]; bar: string } = $props();

	const max = $derived(Math.max(1, ...reasons.map(([, n]) => n)));
</script>

<ul class="space-y-1.5 text-sm">
	{#each reasons as [reason, n] (reason)}
		<li>
			<div class="flex justify-between gap-2">
				<span class="truncate font-mono text-xs text-stone-300" title={reason}>{reason}</span>
				<span class="text-stone-100 tabular-nums">{int(n)}</span>
			</div>
			<div class="mt-0.5 h-1 overflow-hidden rounded-full bg-stone-800">
				<div class="h-full rounded-full {bar}" style="width: {(n / max) * 100}%"></div>
			</div>
		</li>
	{/each}
</ul>
