<script lang="ts">
	import { onMount } from 'svelte';
	import PageMeta from '#lib/components/PageMeta.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const name = $derived(form?.renamed ?? data.account.name);
	const STATE: Record<string, string> = { live: 'On the site', processing: 'Processing', refused: 'Not added', failed: 'Couldn’t process' };

	// A deletion with uploads left goes on by itself, unless the last request deleted none (then by the button).
	let continueForm: HTMLFormElement | undefined = $state();
	const left = $derived(form?.deleting?.left ?? data.deleting);
	onMount(() => {
		if (left !== null && (form?.deleting === undefined || form.deleting.deleted > 0)) continueForm?.requestSubmit();
	});
	const date = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
</script>

<PageMeta title="Your account · Blueprint Atlas" description="Your Blueprint Atlas account." noindex />

<div class="mx-auto max-w-lg space-y-8 py-8">
	{#if left !== null}
		<div class="space-y-3" role="status">
			<h1 class="text-2xl font-semibold text-stone-100">Deleting your account</h1>
			<p class="text-stone-400">
				{left.toLocaleString('en')} upload{left === 1 ? '' : 's'} still to delete. Keep this page open; it carries on by itself, then signs
				you out. If you leave, it carries on the next time you sign in.
			</p>
			<form method="POST" action="?/delete" bind:this={continueForm}>
				<button class="rounded bg-red-900/60 px-4 py-2 text-red-100 hover:bg-red-900">Continue deleting</button>
			</form>
		</div>
	{:else}
		<div class="space-y-2">
			<h1 class="text-2xl font-semibold text-stone-100">{data.welcome ? 'Welcome to Blueprint Atlas' : 'Your account'}</h1>
			{#if data.welcome}
				<p class="text-stone-400">Your account is ready. Check the name below: it’s shown on every blueprint you upload.</p>
			{/if}
			<p class="text-sm text-stone-500">Signed in with {data.providers.join(', ')}.</p>
		</div>

		<form method="POST" action="?/rename" class="space-y-2">
			<label for="name" class="block text-sm font-medium text-stone-300">Display name</label>
			<div class="flex gap-2">
				<input
					id="name"
					name="name"
					value={form?.name ?? name}
					required
					minlength="2"
					maxlength={data.nameMax}
					pattern="[A-Za-z0-9][A-Za-z0-9 _.\-]*"
					autocomplete="nickname"
					class="min-w-0 flex-1 rounded border border-stone-700 bg-stone-900 px-3 py-2 text-stone-100 focus:border-amber-500 focus:outline-none"
				/>
				<button class="rounded bg-amber-500/15 px-4 py-2 text-amber-300 hover:bg-amber-500/25">Save</button>
			</div>
			<p class="text-xs text-stone-500">
				{data.nameRule} Each name is unique ignoring case, and names of factorioprints.com authors can’t be taken. A name you give up stays yours
				for 30 days before anyone else can use it.
			</p>
			{#if form?.problem}<p class="text-sm text-red-300" role="alert">{form.problem}</p>{/if}
			{#if form?.renamed}
				<p class="text-sm text-emerald-300" role="status">
					Saved.{form.namesLeft ? ` Your uploads show the new name after the site’s next update.` : ''}
				</p>
			{/if}
		</form>

		<div class="flex flex-wrap gap-3">
			{#if data.welcome}
				<a class="rounded bg-amber-500/15 px-4 py-2 text-amber-300 hover:bg-amber-500/25" href={data.returnTo}>Continue</a>
			{/if}
			<a class="rounded bg-amber-500/15 px-4 py-2 text-amber-300 hover:bg-amber-500/25" href="/upload">Upload a blueprint</a>
			<form method="POST" action="?/signout">
				<button class="rounded bg-stone-800 px-4 py-2 text-stone-200 hover:bg-stone-700">Sign out</button>
			</form>
		</div>

		<section id="uploads" class="space-y-3">
			<h2 class="text-lg font-medium text-stone-200">Your uploads</h2>
			{#if data.deleted}<p class="text-sm text-emerald-300" role="status">Upload deleted.</p>{/if}
			{#if data.uploads.length === 0}
				<p class="text-sm text-stone-500">None yet.</p>
			{:else}
				<ul class="divide-y divide-stone-800 rounded border border-stone-800">
					{#each data.uploads as u (u.id)}
						<li class="flex items-center gap-3 px-3 py-2 text-sm">
							<a class="min-w-0 flex-1 truncate text-stone-200 hover:text-amber-300" href="/uploads/{u.id}">{u.title}</a>
							<span class={u.state === 'live' ? 'text-emerald-400' : u.state === 'processing' ? 'text-amber-400' : 'text-red-400'}
								>{STATE[u.state]}</span
							>
							{#if u.image === 'pending'}<span class="text-stone-500" title="Screenshot waiting to be checked">· screenshot pending</span>{:else if u.image === 'rejected'}<span class="text-amber-300" title="Screenshot not approved: you can replace it">· screenshot not approved</span>{/if}
							<span class="text-stone-500">{date(u.createdAt)}</span>
							{#if u.state === 'live'}<a class="text-stone-400 hover:text-amber-300" href="/prints/{u.id}">View</a>{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<details class="rounded border border-stone-800 p-4">
			<summary class="cursor-pointer text-sm text-stone-400">Delete account</summary>
			<form method="POST" action="?/delete" class="mt-3 space-y-3">
				<p class="text-sm text-stone-400">
					This deletes your account and every blueprint you uploaded, and signs you out everywhere. It can’t be undone.
				</p>
				<label class="flex items-center gap-2 text-sm text-stone-300">
					<input type="checkbox" name="confirm" value="yes" required /> Yes, delete my account and uploads
				</label>
				{#if form?.deleteProblem}<p class="text-sm text-red-300" role="alert">{form.deleteProblem}</p>{/if}
				<button class="rounded bg-red-900/60 px-4 py-2 text-red-100 hover:bg-red-900">Delete account</button>
			</form>
		</details>
	{/if}
</div>
