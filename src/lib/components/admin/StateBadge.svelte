<script lang="ts">
	import { STATE_LABEL, type ShownState } from './metrics.js';

	let { state }: { state: ShownState } = $props();

	const STYLE: Record<ShownState, string> = {
		starting: 'bg-sky-500/15 text-sky-300',
		running: 'bg-emerald-500/15 text-emerald-300',
		paused: 'bg-amber-500/15 text-amber-300',
		stopping: 'bg-amber-500/15 text-amber-300',
		finished: 'bg-stone-800 text-emerald-300',
		stopped: 'bg-stone-800 text-stone-300',
		failed: 'bg-rose-500/15 text-rose-300',
		crashed: 'bg-rose-500/15 text-rose-300'
	};
	const DOT: Partial<Record<ShownState, string>> = {
		starting: 'bg-sky-400 animate-pulse',
		running: 'bg-emerald-400 animate-pulse',
		paused: 'bg-amber-400',
		stopping: 'bg-amber-400 animate-pulse',
		crashed: 'bg-rose-400'
	};
</script>

<span class="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap {STYLE[state]}">
	{#if DOT[state]}<span class="size-1.5 rounded-full {DOT[state]}" aria-hidden="true"></span>{/if}
	{STATE_LABEL[state]}
</span>
