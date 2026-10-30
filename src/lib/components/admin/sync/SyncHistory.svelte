<script lang="ts">
	import type { SyncRun } from '#lib/sync.js';
	import { duration, when } from '../metrics.js';
	import { STEP_MARK, shortCommit } from './view.js';

	/** The latest updates: start, each source's cursors, each step's mark (its summary on hover), how long, the result. */
	let { runs, now, timeZone }: { runs: SyncRun[]; now: number; timeZone: string } = $props();

	const RESULT: Record<string, string> = {
		finished: 'text-emerald-300',
		stopped: 'text-stone-400',
		failed: 'text-rose-300'
	};
</script>

<section class="rounded-lg border border-stone-800 bg-stone-900/50 p-4" aria-labelledby="updates-title">
	<h2 id="updates-title" class="text-xs font-semibold tracking-wide text-stone-500 uppercase">Updates</h2>
	{#if runs.length}
		<div class="mt-2 overflow-x-auto">
			<table class="w-full min-w-[36rem] text-sm">
				<thead>
					<tr class="text-left text-xs tracking-wide text-stone-500 uppercase">
						<th class="py-1 pr-4 font-medium">Started</th>
						<th class="py-1 pr-4 font-medium">Sources</th>
						<th class="py-1 pr-4 font-medium">Steps</th>
						<th class="py-1 pr-4 font-medium">Took</th>
						<th class="py-1 font-medium">Result</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-stone-800/70">
					{#each runs as r (r.id)}
						{@const failed = r.steps.filter((s) => s.status === 'failed').length}
						{@const warned = r.steps.filter((s) => s.status === 'warning').length}
						<tr>
							<td class="py-1.5 pr-4 whitespace-nowrap text-stone-200">{when(r.started_at, now, timeZone)}</td>
							<td class="py-1.5 pr-4 whitespace-nowrap">
								{#each r.sources as s (s.site)}
									{#if s.polled}
										<!-- A polled site's cursor isn't a commit: what its fetch read. -->
										<code class="block text-stone-300" title={s.blocked ? `${s.site} held back: ${s.blocked}` : s.site}
											>{s.site}{s.counts ? ` +${(s.counts.new ?? 0) + (s.counts.changed ?? 0)}` : ''}{s.blocked ? ' (held back)' : ''}</code
										>
									{:else}
									<code class="block text-stone-300" title={s.blocked ? `${s.site} held back: ${s.blocked}` : s.site}
										>{shortCommit(s.from?.id)}{s.to && s.to.id !== s.from?.id ? ` → ${shortCommit(s.to.id)}` : ''}{s.blocked ? ' (held back)' : ''}</code
									>
									{/if}
								{:else}
									<span class="text-stone-500">–</span>
								{/each}
							</td>
							<td class="py-1.5 pr-4">
								<span class="flex gap-1">
									{#each r.steps as s (s.id)}
										<span class="grid size-5 place-items-center rounded text-[0.65rem] font-bold {STEP_MARK[s.status].class}" title="{s.id}: {s.summary ?? STEP_MARK[s.status].label}">
											{STEP_MARK[s.status].mark}
										</span>
									{/each}
								</span>
							</td>
							<td class="py-1.5 pr-4 whitespace-nowrap text-stone-400 tabular-nums">{duration((r.finished_at ?? r.updated_at) - r.started_at)}</td>
							<td class="py-1.5 whitespace-nowrap {RESULT[r.state] ?? 'text-amber-200'}">
								{r.state === 'finished' && (failed || warned) ? `finished, ${failed ? `${failed} failed` : `${warned} to look at`}` : r.state}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<p class="mt-2 text-sm text-stone-400">No updates yet. <b class="text-stone-200">Update everything</b> runs one; so does <code>bun run sync</code>.</p>
	{/if}
</section>
