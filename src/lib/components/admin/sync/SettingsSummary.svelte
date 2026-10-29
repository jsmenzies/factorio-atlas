<script lang="ts">
	import type { SyncSettings } from '#lib/sync.js';
	import { int, when } from '../metrics.js';

	/** What an update covers, from the saved settings; changed on /admin/settings. */
	let { settings, savedAt, now, timeZone }: { settings: SyncSettings; savedAt: number | null; now: number; timeZone: string } = $props();

	const rows = $derived([
		{ label: 'Render every 2.0+ print', value: 'yes' },
		{ label: 'And the top favourites', value: settings.top ? int(settings.top) : 'none' },
		{ label: 'Prints to render per update', value: settings.perUpdate === null ? 'all that need it' : int(settings.perUpdate) },
		{ label: 'Copy screenshots', value: settings.screenshots ? (settings.imgurRecheck === 'weekly' ? 'yes, recheck weekly' : 'yes') : 'no' },
		{ label: 'Name new authors', value: settings.authors ? `yes, ≤ ${int(settings.authorLimit)} from Firebase` : 'no' }
	]);
</script>

<section class="rounded-lg border border-stone-800 bg-stone-900/50 p-4" aria-labelledby="covers-title">
	<h2 id="covers-title" class="text-xs font-semibold tracking-wide text-stone-500 uppercase">What an update covers</h2>
	<dl class="mt-2 space-y-1.5 text-sm">
		{#each rows as r (r.label)}
			<div class="flex justify-between gap-3">
				<dt class="text-stone-300">{r.label}</dt>
				<dd class="text-right text-stone-100 tabular-nums">{r.value}</dd>
			</div>
		{/each}
	</dl>
	<p class="mt-3 text-xs text-stone-500">
		{savedAt ? `Saved ${when(savedAt, now, timeZone)}` : 'The defaults: nothing saved yet'} ·
		<a href="/admin/settings" class="text-stone-300 underline decoration-stone-600 hover:text-amber-300">Change settings</a>
	</p>
</section>
