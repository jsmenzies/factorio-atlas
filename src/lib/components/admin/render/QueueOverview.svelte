<script lang="ts">
	import type { QueueOverview } from '#lib/server/admin/render.js';
	import type { JobStatus } from '#lib/server/render-queue.js';
	import { bytes, compact, int, percent } from '../metrics.js';

	/** Every page in the queue by status, across all runs (or one run's pages), and what the rendered ones store. */
	let {
		queue,
		title = 'Queue',
		scope = 'across all runs',
		empty = 'The queue is empty: no page has been queued yet.'
	}: { queue: QueueOverview; title?: string; scope?: string; empty?: string } = $props();

	const STATUS: { key: JobStatus; label: string; hint: string; color: string; anchor?: string }[] = [
		{ key: 'done', label: 'Rendered', hint: 'files on disk', color: 'bg-emerald-500', anchor: 'rendered' },
		{ key: 'rendering', label: 'Rendering', hint: 'in a worker now', color: 'bg-sky-500', anchor: 'in-flight' },
		{ key: 'pending', label: 'Pending', hint: 'waiting for a run', color: 'bg-stone-500' },
		{ key: 'skipped', label: 'Skipped', hint: 'modded, empty or pre-2.0', color: 'bg-amber-500/80', anchor: 'skipped' },
		{ key: 'failed', label: 'Failed', hint: 'out of attempts', color: 'bg-rose-500', anchor: 'failed' }
	];

	const done = $derived(queue.byStatus.done);
	const waiting = $derived(queue.byStatus.pending.pages + queue.byStatus.rendering.pages);
	const perPage = $derived(done.pages > 0 ? done.bytes / done.pages : null);
	const perPrint = $derived(queue.printsDone > 0 ? done.bytes / queue.printsDone : null);
	const whole = $derived(Math.max(1, queue.pages));

	const card = 'rounded-lg border border-stone-800 bg-stone-900/50 p-4';
	const label = 'text-xs font-medium tracking-wide text-stone-500 uppercase';
</script>

<section class="space-y-3" aria-labelledby="queue">
	<div class="flex flex-wrap items-baseline justify-between gap-2">
		<h2 id="queue" class="text-lg font-semibold text-stone-100">
			{title} <span class="font-normal text-stone-500">· {int(queue.pages)} pages of {int(queue.prints)} prints {scope}</span>
		</h2>
	</div>
	{#if queue.pages === 0}
		<p class="text-sm text-stone-500">{empty}</p>
	{:else}
		<div class="grid gap-4 lg:grid-cols-[2fr_1fr]">
			<div class="{card} space-y-4">
				<div
					class="flex h-3 w-full overflow-hidden rounded-full bg-stone-800"
					role="img"
					aria-label={STATUS.map((s) => `${int(queue.byStatus[s.key].pages)} ${s.label.toLowerCase()}`).join(', ')}
				>
					{#each STATUS as s (s.key)}
						{@const n = queue.byStatus[s.key].pages}
						{#if n > 0}<div class="{s.color} h-full" style="width: {(n / whole) * 100}%" title="{s.label}: {int(n)}"></div>{/if}
					{/each}
				</div>
				<dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-5">
					{#each STATUS as s (s.key)}
						{@const n = queue.byStatus[s.key].pages}
						<div class="flex items-start gap-2 {n === 0 ? 'opacity-45' : ''}">
							<span class="mt-1.5 size-2.5 shrink-0 rounded-sm {s.color}" aria-hidden="true"></span>
							<div class="min-w-0">
								<dt class="text-stone-200">
									{#if s.anchor && n > 0}<a href="#{s.anchor}" class="hover:text-amber-300">{s.label}</a>{:else}{s.label}{/if}
									<span class="ml-1 text-stone-100 tabular-nums">{int(n)}</span>
								</dt>
								<dd class="text-xs text-stone-500">{n > 0 ? `${percent(n, queue.pages)} · ` : ''}{s.hint}</dd>
							</div>
						</div>
					{/each}
				</dl>
				<p class="text-xs text-stone-500">
					{int(queue.printsDone)} of {int(queue.prints)} prints have at least one rendered page.
				</p>
				{#if queue.uploads.length}
					<p class="text-xs text-stone-500">
						In buckets:
						{#each queue.uploads as u, i (u.target)}{i ? '; ' : ''}<span class="text-stone-300">{u.target}</span>
							{int(u.pages)} pages{u.current < u.pages ? ` (${int(u.pages - u.current)} at an older version)` : ''}{/each}
						of {int(done.pages)} rendered.
					</p>
				{/if}
			</div>

			<div class="{card} space-y-1">
				<h3 class={label}>On disk</h3>
				<p class="text-lg text-stone-100 tabular-nums">{bytes(done.bytes)} <span class="text-sm text-stone-400">· {int(done.files)} files</span></p>
				<p class="text-sm text-stone-500">
					for {int(done.pages)} rendered pages{perPage !== null ? `, ${bytes(perPage)} each on average` : ''} ({compact(done.entities)} entities)
				</p>
				{#if perPrint !== null}
					<p class="text-sm text-stone-500">{bytes(perPrint)} per print, over {int(queue.printsDone)} prints</p>
				{/if}
				{#if perPage !== null && waiting > 0}
					<p class="pt-2 text-sm text-stone-300">
						≈ {bytes(done.bytes + perPage * waiting)} <span class="text-stone-500">once the {int(waiting)} waiting pages render</span>
					</p>
					<p class="text-xs text-stone-500">Average per rendered page × pages pending or rendering; skips and big books shift it.</p>
				{/if}
			</div>
		</div>
	{/if}
</section>
