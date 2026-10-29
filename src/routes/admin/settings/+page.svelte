<script lang="ts">
	import { enhance } from '$app/forms';
	import { bytes, duration, int, when } from '#lib/components/admin/metrics.js';
	import { serverClock, syncTimeZone } from '#lib/components/admin/live.svelte.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const offset = $derived(data.serverNow - Date.now());
	const clock = serverClock(() => offset);
	syncTimeZone(() => data.timeZone);

	const s = $derived(data.busy ? null : data.settings);
	const union = $derived(data.busy ? null : data.scopes.union);
	let saving = $state(false);

	// What the top N typed would add to the render scope (scripts/sync.ts --top-preview, ≈ 1 s).
	let top = $state<number | null>(null);
	let preview = $state<{
		n: number;
		cutoff: number;
		adds: number;
		estimate: { pages: number; dollars: number; bytes: number; storagePerMonth: number; seconds: number };
	} | null>(null);
	let previewError = $state<string | null>(null);
	$effect(() => {
		const n = top;
		if (n === null || !Number.isInteger(n) || n < 0 || n > 100_000) return;
		const timer = setTimeout(async () => {
			try {
				const res = await fetch('/admin/__sync/top-preview', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ n })
				});
				const out = (await res.json()) as { ok?: boolean; error?: string; result?: typeof preview };
				if (!res.ok || !out.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
				preview = out.result ?? null;
				previewError = null;
			} catch (e) {
				previewError = e instanceof Error ? e.message : String(e);
			}
		}, 400);
		return () => clearTimeout(timer);
	});
	$effect(() => {
		if (s && top === null) top = s.top;
	});

	const invalid = (field: string) => !!form && 'errors' in form && (form.errors as string[]).includes(field);
	const input = 'w-28 rounded-md border bg-stone-950 px-2 py-1 text-right text-sm text-stone-100 tabular-nums';
	const field = (name: string) => `${input} ${invalid(name) ? 'border-rose-500' : 'border-stone-700'}`;
	const group = 'col-span-full pt-2 text-xs font-semibold tracking-wide text-stone-500 uppercase';
	const hint = 'block text-xs text-stone-500';
</script>

<svelte:head><title>Settings · Admin · Blueprint Atlas</title></svelte:head>

<div class="space-y-3">
	<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
		<h1 class="text-2xl font-semibold text-stone-100">Settings</h1>
		<p class="text-xs text-stone-500">Used by every update: the Overview's button and <code>bun run sync</code></p>
	</div>

	{#if !s || !union}
		<div class="rounded-lg border border-dashed border-stone-800 p-6 text-sm text-stone-400">
			<p class="text-stone-200">The local database is busy (a run is writing to it); reload in a moment.</p>
		</div>
	{:else}
		<div class="grid gap-3 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
			<form
				method="POST"
				action="?/save"
				class="rounded-lg border border-stone-800 bg-stone-900/50 p-4"
				use:enhance={() => {
					saving = true;
					return async ({ update }) => {
						await update({ reset: false });
						saving = false;
					};
				}}
			>
				<div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 text-sm">
					<p class={group}>What gets rendered</p>
					<span class="text-stone-200">Every print with a 2.0+ page<span class={hint}>{int(data.busy ? 0 : data.scopes.modern.total)} prints today; always on</span></span>
					<span class="pr-1 text-right text-stone-400">always</span>

					<label for="top" class="text-stone-200">
						The top N favourites, older prints included
						<span class={hint}>A print that drops out of the top keeps its renders. 0: no top list.</span>
					</label>
					<input id="top" name="top" type="number" min="0" max="100000" step="1" value={s.top} oninput={(e) => (top = Number(e.currentTarget.value))} class={field('top')} />

					<label for="perUpdate" class="text-stone-200">
						At most this many prints rendered per update
						<span class={hint}>The rest wait for the next update. Blank: every print with work.</span>
					</label>
					<input id="perUpdate" name="perUpdate" type="number" min="1" max="100000" step="1" value={s.perUpdate ?? ''} placeholder="all" class={field('perUpdate')} />

					<p class={group}>How it renders</p>
					<label for="workers" class="text-stone-200">
						Render workers
						<span class={hint}>Blank: half the CPU threads. 8 suits this machine (see the memory notes).</span>
					</label>
					<input id="workers" name="workers" type="number" min="1" max="64" step="1" value={s.workers ?? ''} placeholder="default" class={field('workers')} />

					<p class={group}>Other steps</p>
					<label for="screenshots" class="text-stone-200">Copy new screenshots from Imgur<span class={hint}>At most 4 requests a second; then upload and update the cards.</span></label>
					<input id="screenshots" name="screenshots" type="checkbox" checked={s.screenshots} class="size-4 justify-self-end accent-amber-500" />

					<label for="imgurRecheck" class="text-stone-200">
						Recheck Imgur for deleted screenshots
						<span class={hint}>Asks about every copied image: ≈ 75 min at 4 a second.</span>
					</label>
					<select id="imgurRecheck" name="imgurRecheck" class="rounded-md border border-stone-700 bg-stone-950 px-2 py-1 text-sm text-stone-100">
						<option value="never" selected={s.imgurRecheck === 'never'}>never</option>
						<option value="weekly" selected={s.imgurRecheck === 'weekly'}>weekly</option>
					</select>

					<label for="authors" class="text-stone-200">Name new authors<span class={hint}>Their records first, then Firebase, once per author, ever.</span></label>
					<input id="authors" name="authors" type="checkbox" checked={s.authors} class="size-4 justify-self-end accent-amber-500" />

					<label for="authorLimit" class="text-stone-200">At most this many Firebase lookups per update</label>
					<input id="authorLimit" name="authorLimit" type="number" min="1" max="1000" step="1" value={s.authorLimit} class={field('authorLimit')} />

					<p class={group}>Safety</p>
					<label for="maxChange" class="text-stone-200">
						Stop if the mirror changed more than this share of its prints since the last pull (%)
						<span class={hint}>Guards against a layout change like 11 Oct's, which moved every file.</span>
					</label>
					<input id="maxChange" name="maxChange" type="number" min="1" max="100" step="1" value={Math.round(s.maxChange * 100)} class={field('maxChange')} />
				</div>

				<div class="mt-4 flex flex-wrap items-center gap-3 border-t border-stone-800 pt-3">
					<button disabled={saving} class="rounded-lg border border-amber-500 bg-amber-500 px-4 py-1.5 text-sm font-semibold text-stone-950 hover:bg-amber-400 disabled:opacity-60">
						{saving ? 'Saving…' : 'Save'}
					</button>
					{#if form && 'ok' in form}
						<span class="text-sm text-emerald-300" role="status">Saved.</span>
					{:else if form && 'message' in form}
						<span class="text-sm text-rose-300" role="alert">{form.message}</span>
					{:else}
						<span class="text-xs text-stone-500">{data.savedAt ? `Last saved ${when(data.savedAt, clock.now, data.timeZone)}` : 'Nothing saved yet: these are the defaults'}</span>
					{/if}
				</div>
			</form>

			<section class="space-y-3 rounded-lg border border-stone-800 bg-stone-900/50 p-4 text-sm" aria-labelledby="today-title">
				<h2 id="today-title" class="text-xs font-semibold tracking-wide text-stone-500 uppercase">What these settings mean today</h2>
				<dl class="space-y-1">
					{#each [['Prints in render scope', union.total], ['Rendered', union.rendered], ["Can't be drawn", union.none], ['Left to render', union.left]] as [label, n] (label)}
						<div class="flex justify-between gap-3"><dt class="text-stone-400">{label}</dt><dd class="text-stone-100 tabular-nums">{int(n as number)}</dd></div>
					{/each}
				</dl>
				{#if preview && preview.n !== s.top}
					<div class="border-t border-stone-800 pt-3">
						<p class="text-stone-200">
							A top {int(preview.n)} (≥ {int(preview.cutoff)} favourites) would add <b class="text-amber-200">{int(preview.adds)} prints</b>{preview.adds
								? ', about:'
								: '.'}
						</p>
						{#if preview.adds}
							<dl class="mt-1 space-y-1">
								<div class="flex justify-between gap-3"><dt class="text-stone-400">Pages</dt><dd class="tabular-nums">≈ {int(preview.estimate.pages)}</dd></div>
								<div class="flex justify-between gap-3"><dt class="text-stone-400">Rendering</dt><dd class="tabular-nums">≈ {duration(preview.estimate.seconds * 1000)}</dd></div>
								<div class="flex justify-between gap-3"><dt class="text-stone-400">Uploading, once</dt><dd class="tabular-nums">≈ ${preview.estimate.dollars.toFixed(2)}</dd></div>
								<div class="flex justify-between gap-3">
									<dt class="text-stone-400">Storing</dt><dd class="tabular-nums">+{bytes(preview.estimate.bytes)} · ≈ ${preview.estimate.storagePerMonth.toFixed(2)}/month</dd>
								</div>
							</dl>
						{/if}
						{#if preview.n < s.top}<p class="mt-1 text-xs text-stone-500">Lowering N removes nothing: rendered prints keep their renders.</p>{/if}
					</div>
				{/if}
				{#if previewError}<p class="text-xs text-rose-300">{previewError}</p>{/if}
				<p class="text-xs text-stone-500">
					Estimates use today's averages: 11 pages a print, 55 uploads and 2.75 MB a page, 2.6 hours per 1,000 prints at 8 workers.
				</p>
			</section>
		</div>
	{/if}
</div>
