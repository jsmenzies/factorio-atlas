<script lang="ts">
	import { isLiveState, KIND_LABEL, shownState, when } from '#lib/components/admin/metrics.js';
	import { poll, serverClock, syncTimeZone } from '#lib/components/admin/live.svelte.js';
	import RunDetail from '#lib/components/admin/RunDetail.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const offset = $derived(data.serverNow - Date.now());
	const clock = serverClock(() => offset);
	const runState = $derived(shownState(data.run, clock.now, data.staleMs));
	const interval = $derived(isLiveState(runState) ? 4000 : runState === 'crashed' ? 15000 : null);
	poll(() => interval);
	syncTimeZone(() => data.timeZone);

	const message = $derived(form && 'message' in form ? form.message : undefined);
</script>

<svelte:head><title>{KIND_LABEL[data.run.kind]} {when(data.run.started_at, data.serverNow, data.timeZone)} · Pipeline · Blueprint Atlas</title></svelte:head>

<div class="space-y-5">
	<a href="/admin/pipeline" class="text-sm text-stone-400 hover:text-amber-300">← Pipeline</a>
	<RunDetail run={data.run} failed={data.failed} now={clock.now} staleMs={data.staleMs} heartbeatMs={data.heartbeatMs} {message} timeZone={data.timeZone} />
</div>
