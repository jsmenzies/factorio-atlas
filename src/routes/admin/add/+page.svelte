<script lang="ts">
	import { dev } from '$app/env';
	import { enhance, type SubmitFunction } from '$app/forms';
	import type { AddView } from '#lib/add-by-link.js';
	import { parsePostLink } from '#lib/factoriobin-link.js';
	import { formatDate } from '#lib/format.js';
	import { plainText } from '#lib/richtext.js';
	import type { PageProps } from './$types';

	// Add one print by its link on another site (factoriobin.com). Deployed: the form actions, in the Worker
	// (+page.server.ts). Under `vite dev`: `bun run add` through the dev plugin (scripts/add/dev-plugin.ts).
	let { form }: PageProps = $props();

	let link = $state('');
	let stage: 'prod' | 'local' = $state('prod');
	let busy: 'preview' | 'add' | null = $state(null);
	/** Under dev, the command's answer; deployed, the action's. */
	let devView: AddView | null = $state(null);
	let devProblem: string | null = $state(null);

	const view = $derived(dev ? devView : form && 'view' in form ? (form.view as AddView) : null);
	const problem = $derived(dev ? devProblem : form && 'problem' in form ? String(form.problem) : null);
	const valid = $derived(parsePostLink(link) !== null);

	const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('en-US')} KB`;
	const count = (n: number) => n.toLocaleString('en-US');
	const TYPES: Record<string, string> = {
		blueprint: 'Blueprint',
		'blueprint-book': 'Blueprint book',
		'upgrade-planner': 'Upgrade planner',
		'deconstruction-planner': 'Deconstruction planner'
	};

	/** Under dev: run the command and show its answer. */
	const runLocal = async (plan: boolean) => {
		busy = plan ? 'preview' : 'add';
		devProblem = null;
		try {
			const res = await fetch('/admin/__add', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ link, stage, plan })
			});
			const out = (await res.json().catch(() => ({}))) as { ok?: boolean; view?: AddView; error?: string };
			if (!res.ok || !out.view) throw new Error(out.error ?? `HTTP ${res.status}`);
			devView = out.view;
		} catch (e) {
			devProblem = e instanceof Error ? e.message : String(e);
		} finally {
			busy = null;
		}
	};

	const onLocalSubmit = (e: SubmitEvent) => {
		e.preventDefault();
		void runLocal((e.submitter as HTMLButtonElement | null)?.value !== 'add');
	};

	const track: SubmitFunction = ({ action }) => {
		busy = action.search.includes('add') ? 'add' : 'preview';
		return async ({ update }) => {
			await update({ reset: false });
			busy = null;
		};
	};

	const printLink = (id: string) => `/prints/${id}`;
	/** The result box's colour: green when it is (or would be) on the site, amber when not added, red on failure. */
	const tone = (v: AddView) =>
		!v.ok || v.result.status === 'failed'
			? 'border-red-800 bg-red-950/30'
			: ['new', 'joins', 'already'].includes(v.result.status)
				? 'border-emerald-800 bg-emerald-950/30'
				: 'border-amber-800 bg-amber-950/30';
</script>

<svelte:head><title>Add by link · Admin</title></svelte:head>

{#snippet fields()}
	<label class="block space-y-1">
		<span class="text-sm text-stone-300">factoriobin link</span>
		<input
			name="link"
			type="url"
			inputmode="url"
			autocomplete="off"
			spellcheck="false"
			required
			bind:value={link}
			placeholder="https://factoriobin.com/post/…"
			class="w-full rounded border border-stone-700 bg-stone-950 px-3 py-2 font-mono text-sm text-stone-100 placeholder:text-stone-600 focus:border-amber-500 focus:outline-none"
		/>
	</label>
	{#if link.trim() && !valid}
		<p class="text-sm text-amber-300">Not a factoriobin post link (https://factoriobin.com/post/&lt;id&gt;).</p>
	{/if}
	{#if dev}
		<fieldset class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-stone-300">
			<legend class="sr-only">Stage</legend>
			<span class="text-stone-500">Add to</span>
			<label class="flex items-center gap-1.5"><input type="radio" name="stage" value="prod" bind:group={stage} /> prod</label>
			<label class="flex items-center gap-1.5"><input type="radio" name="stage" value="local" bind:group={stage} /> local</label>
		</fieldset>
	{/if}
	<div class="flex flex-wrap gap-2">
		<button
			name="do"
			value="preview"
			formaction="?/preview"
			disabled={!valid || busy !== null}
			class="rounded border border-stone-600 px-3 py-1.5 text-sm text-stone-200 hover:border-amber-500 disabled:opacity-50"
			>{busy === 'preview' ? 'Looking up…' : 'Look up'}</button
		>
		<button
			name="do"
			value="add"
			formaction="?/add"
			disabled={!valid || busy !== null}
			class="rounded bg-amber-600 px-3 py-1.5 text-sm font-medium text-stone-950 hover:bg-amber-500 disabled:opacity-50"
			>{busy === 'add' ? 'Adding…' : dev ? `Add to ${stage}` : 'Add'}</button
		>
	</div>
{/snippet}

<div class="max-w-3xl space-y-6">
	<header class="space-y-1">
		<h1 class="text-xl font-semibold text-stone-100">Add by link</h1>
		<p class="text-sm text-stone-400">
			Paste a factoriobin.com post someone shared. It is read once and goes through the same checks as every print: an approved removal
			refuses it, and the same blueprint already here gets it as another source instead of a second print. Book page links add the whole
			post. No screenshot is copied (factoriobin has only its own render); the print's render (2.0+ pages) comes with the next update.
		</p>
		{#if dev}
			<p class="text-sm text-stone-500">
				Local: runs <code class="text-stone-400">bun run add &lt;link&gt; --stage {stage}</code> on this machine, with no size limit, and puts
				the print in the record store.
			</p>
		{/if}
	</header>

	{#if dev}
		<form class="space-y-3" onsubmit={onLocalSubmit}>{@render fields()}</form>
	{:else}
		<form method="POST" action="?/preview" class="space-y-3" use:enhance={track}>{@render fields()}</form>
	{/if}

	{#if problem}
		<p class="rounded-lg border border-red-800 bg-red-950/30 p-4 text-sm text-red-300" aria-live="polite">{problem}</p>
	{/if}

	{#if view}
		<section class="space-y-4 rounded-lg border p-4 text-sm {tone(view)}" aria-live="polite">
			{#if 'post' in view && view.post}
				{@const p = view.post}
				<div class="space-y-2">
					<h2 class="text-base font-medium break-words text-stone-100">
						<a href={p.url} target="_blank" rel="noopener noreferrer nofollow" class="hover:text-amber-300">{plainText(p.title)}</a>
					</h2>
					<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-stone-300">
						<dt class="text-stone-500">Post</dt>
						<dd class="font-mono break-all">{p.id}</dd>
						<dt class="text-stone-500">Kind</dt>
						<dd>{TYPES[p.type] ?? p.type}{p.version ? `, Factorio ${p.version}` : ''}</dd>
						{#if p.entities !== null || p.tiles !== null}
							<dt class="text-stone-500">Size</dt>
							<dd>{count(p.entities ?? 0)} entities, {count(p.tiles ?? 0)} tiles</dd>
						{/if}
						{#if p.stringBytes !== null}
							<dt class="text-stone-500">String</dt>
							<dd>{kb(p.stringBytes)}</dd>
						{/if}
						<dt class="text-stone-500">Posted</dt>
						<dd>{p.createdAt ? formatDate(p.createdAt) : 'unknown'}{p.postedBy ? ` by ${p.postedBy}` : ', anonymously'}</dd>
						{#if p.expiresAt}
							<dt class="text-stone-500">Expires</dt>
							<dd>{formatDate(p.expiresAt)} on factoriobin (our copy stays)</dd>
						{/if}
					</dl>
					{#if p.linkedNode !== null}
						<p class="text-stone-400">The link names book page {p.linkedNode}: the whole post is added.</p>
					{/if}
				</div>
			{/if}

			<div class="space-y-1 text-stone-200">
				{#if !view.ok}
					<p>{view.message}</p>
				{:else}
					{@const r = view.result}
					{#if r.status === 'new'}
						<p>
							{r.planned ? 'New: adding makes it' : 'Added as'}
							{#if r.planned}<span class="font-mono">{r.printId}</span>.{:else}<a href={printLink(r.printId)} class="font-mono text-amber-300 hover:underline"
									>{r.printId}</a
								>.{/if}
						</p>
					{:else if r.status === 'joins'}
						<p>
							Already here as <a href={printLink(r.printId)} class="font-mono text-amber-300 hover:underline">{r.printId}</a>, the same blueprint:
							{r.planned
								? 'adding makes this post another of its sources, not a second print.'
								: r.shown
									? 'joined as another source, and shown now, as it was posted first.'
									: 'joined as another source.'}
						</p>
					{:else if r.status === 'already'}
						<p>Already added: <a href={printLink(r.printId)} class="font-mono text-amber-300 hover:underline">{r.printId}</a>.</p>
					{:else if r.status === 'blocked'}
						<p>Refused: an approved removal blocks it ({r.by === 'source' ? 'this post' : r.by === 'print' ? 'its print' : 'its content'}).</p>
					{:else if r.status === 'unreadable'}
						<p>Refused: its string can't be read ({r.reason}).</p>
					{:else if r.status === 'too-big'}
						<p>
							Too big to add here: {r.by === 'string' ? `${kb(r.size)} of string, over ${kb(r.limit)}` : `${count(r.size)} entities and tiles, over ${count(r.limit)}`}.
							{#if !dev}Add it from the local admin page, or run <code class="break-all text-stone-300">bun run add {view.link} --stage prod</code>.{/if}
						</p>
					{:else if r.status === 'failed'}
						<p>Failed: {r.reason}. Nothing the site shows changed; try again.</p>
					{/if}
					{#if (r.status === 'new' || r.status === 'joins') && r.suggestions.length}
						<div class="pt-2 text-stone-400">
							Looks like (not joined):
							<ul class="mt-1 list-inside list-disc">
								{#each r.suggestions as s (s.printId)}
									<li>
										<a href={printLink(s.printId)} class="font-mono text-stone-300 hover:text-amber-300">{s.printId}</a>
										{s.kind === 'small-exact' ? '(the same, but small)' : s.kind === 'layout' ? '(same layout)' : `(${s.shared} pages shared)`}
									</li>
								{/each}
							</ul>
						</div>
					{/if}
					{#if !r.planned && r.status === 'new'}
						<p class="pt-2 text-stone-400">
							{view.stored
								? `In the record store (${view.stage}): the next update renders its 2.0+ pages.`
								: 'The next update copies it into the record store and renders its 2.0+ pages.'}
						</p>
					{/if}
				{/if}
			</div>
		</section>
	{/if}
</div>
