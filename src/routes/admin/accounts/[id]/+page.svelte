<script lang="ts">
	import { onMount } from 'svelte';
	import type { PageProps } from './$types';

	// One site account (lib/server/admin/accounts.ts): facts, uploads, and the admin's actions.
	let { data, form }: PageProps = $props();
	const a = $derived(data.account);

	const date = (ms: number | null) => (ms === null ? '—' : new Date(ms).toISOString().slice(0, 16).replace('T', ' '));
	const STATE: Record<string, string> = { live: 'Live', processing: 'Processing', refused: 'Refused', failed: 'Failed' };

	// A deletion with uploads left goes on by itself, as on the owner's account page, unless the last step deleted none.
	let continueForm: HTMLFormElement | undefined = $state();
	const left = $derived(form && 'deleting' in form && form.deleting ? form.deleting.left : null);
	onMount(() => {
		if (form && 'deleting' in form && form.deleting && form.deleting.deleted > 0) continueForm?.requestSubmit();
	});
	let typed = $state('');
</script>

<svelte:head><title>{a.name} · Accounts · Admin</title></svelte:head>

<div class="space-y-8">
	<header class="space-y-1">
		<p class="text-sm"><a class="text-stone-400 hover:text-amber-300" href="/admin/accounts">‹ Accounts</a></p>
		<h1 class="text-xl font-semibold break-words text-stone-100">{a.name}</h1>
		{#if a.deletingAt !== null}
			<p class="text-sm text-red-300">Being deleted since {date(a.deletingAt)}: it can’t upload, edit or rename.</p>
		{/if}
		{#if a.bannedAt !== null}<p class="text-sm text-red-300">Banned {date(a.bannedAt)}.</p>{/if}
	</header>

	<dl class="grid max-w-xl grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
		<dt class="text-stone-500">Signs in with</dt>
		<dd class="text-stone-200">{a.providers.join(', ') || '—'}</dd>
		<dt class="text-stone-500">Joined</dt>
		<dd class="text-stone-200 tabular-nums">{date(a.createdAt)} UTC</dd>
		<dt class="text-stone-500">Last seen ≈</dt>
		<dd class="text-stone-200 tabular-nums">
			{a.lastSeen === null ? '— (no session left)' : `${date(a.lastSeen)} UTC`}
			<span class="block text-xs text-stone-500">Latest session start or renewal; the last visit may be up to 15 days later.</span>
		</dd>
		<dt class="text-stone-500">Active sessions</dt>
		<dd class="text-stone-200 tabular-nums">{a.sessions}</dd>
		<dt class="text-stone-500">Uploads</dt>
		<dd class="text-stone-200">
			{a.uploads.live} live, {a.uploads.processing} processing, {a.uploads.refused} refused, {a.uploads.failed} failed
		</dd>
		<dt class="text-stone-500">Screenshots pending</dt>
		<dd class="text-stone-200 tabular-nums">{a.pendingScreenshots}</dd>
	</dl>

	<section class="space-y-3">
		<h2 class="font-medium text-stone-200">Uploads ({data.uploads.length})</h2>
		{#if !data.uploads.length}
			<p class="text-sm text-stone-500">None.</p>
		{:else}
			<ul class="divide-y divide-stone-800 rounded border border-stone-800">
				{#each data.uploads as u (u.id)}
					<li class="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-sm">
						<span class="min-w-0 flex-1 basis-48 truncate text-stone-200">{u.title}</span>
						<span class={u.state === 'live' ? 'text-emerald-400' : u.state === 'processing' ? 'text-amber-400' : 'text-red-400'}
							>{STATE[u.state]}{u.refusedReason ? ` (${u.refusedReason})` : ''}</span
						>
						{#if u.image === 'pending'}<span class="text-amber-300">screenshot pending</span>{/if}
						<span class="text-stone-500 tabular-nums">{date(u.createdAt).slice(0, 10)}</span>
						{#if u.state === 'live'}<a class="text-stone-400 hover:text-amber-300" href="/prints/{u.id}">Print</a>{/if}
						<a class="text-stone-400 hover:text-amber-300" href="/uploads/{u.id}" title="The owner's page: opens only when signed in as this account"
							>Owner’s page</a
						>
						<span class="font-mono text-xs text-stone-600">{u.id}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#if form && 'problem' in form}
		<p class="rounded-lg border border-red-800 bg-red-950/30 p-3 text-sm text-red-300" role="alert">{form.problem}</p>
	{/if}

	<section class="space-y-3">
		<h2 class="font-medium text-stone-200">Sign out everywhere</h2>
		<form method="POST" action="?/signout" class="flex flex-wrap items-center gap-3 text-sm">
			<p class="text-stone-400">
				Ends {a.sessions === 1 ? 'its one session' : `all ${a.sessions} of its sessions`}. The account can sign in again.
			</p>
			<button class="rounded bg-stone-700 px-3 py-1 text-stone-100 hover:bg-stone-600">Sign out everywhere</button>
		</form>
		{#if form && 'ended' in form}
			<p class="text-sm text-emerald-300" role="status">Ended {form.ended} session{form.ended === 1 ? '' : 's'}.</p>
		{/if}
	</section>

	<!-- Suspend and ban come later (users.banned_at / ban_reason): their section goes here. -->

	<section class="space-y-3 rounded-lg border border-red-900/60 p-4">
		<h2 class="font-medium text-red-200">Delete account</h2>
		{#if left !== null}
			<div class="space-y-2" role="status">
				<p class="text-sm text-stone-300">
					{left.toLocaleString('en')} upload{left === 1 ? '' : 's'} still to delete. Keep this page open; it carries on by itself.
				</p>
				<form method="POST" action="?/delete" bind:this={continueForm}>
					<button class="rounded bg-red-900/60 px-3 py-1 text-sm text-red-100 hover:bg-red-900">Continue deleting</button>
				</form>
			</div>
		{:else if a.deletingAt !== null}
			<form method="POST" action="?/delete" class="space-y-2 text-sm">
				<p class="text-stone-300">A deletion was started and not finished. Continue it: the uploads left, then the account.</p>
				<button class="rounded bg-red-900/60 px-3 py-1 text-red-100 hover:bg-red-900">Continue deleting</button>
			</form>
		{:else}
			<form method="POST" action="?/delete" class="space-y-2 text-sm">
				<p class="text-stone-400">
					The same as its owner deleting it: every upload goes (each print answers 410 unless another site also has it), then its sign-ins,
					sessions and daily counts. Its name stays held for 30 days. It can’t be undone.
				</p>
				<label class="block text-stone-300">
					Type <span class="font-mono text-stone-100">{a.name}</span> to confirm
					<input
						name="name"
						bind:value={typed}
						autocomplete="off"
						spellcheck="false"
						class="mt-1 block w-full max-w-sm rounded border border-stone-700 bg-stone-900 px-2 py-1 text-stone-100 focus:border-red-500 focus:outline-none"
					/>
				</label>
				<button disabled={typed !== a.name} class="rounded bg-red-600 px-3 py-1 font-medium text-white hover:bg-red-500 disabled:opacity-40"
					>Delete account</button
				>
			</form>
		{/if}
	</section>
</div>
