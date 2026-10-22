<script lang="ts">
	import type { RenderRun } from '#lib/server/admin/render.js';
	import { int } from '../metrics.js';
	import { renderOutcomeParts } from './metrics.js';

	/** Outcomes as segments of the run's total; the rest of the track is what's left. */
	let { run, size = 'lg' }: { run: RenderRun; size?: 'lg' | 'sm' } = $props();

	const parts = $derived(renderOutcomeParts(run));
	const whole = $derived(Math.max(run.total, run.done, 1));
</script>

<div
	class="flex w-full overflow-hidden rounded-full bg-stone-800 {size === 'lg' ? 'h-3' : 'h-1.5'}"
	role="img"
	aria-label="{int(run.done)} of {int(run.total)} pages done: {parts.map((p) => `${int(p.n)} ${p.label.toLowerCase()}`).join(', ') || 'none yet'}"
>
	{#each parts as p (p.key)}
		<div class="{p.color} h-full transition-[width] duration-700" style="width: {(p.n / whole) * 100}%" title="{p.label}: {int(p.n)}"></div>
	{/each}
</div>
