<script lang="ts">
	import type { PageProps } from './$types';

	// Site accounts (migration 0023), newest first (lib/server/admin/accounts.ts).
	let { data }: PageProps = $props();

	const date = (ms: number | null) => (ms === null ? '—' : new Date(ms).toISOString().slice(0, 10));
	const pageHref = (p: number) => {
		const params = new URLSearchParams();
		if (data.q) params.set('q', data.q);
		if (p > 1) params.set('p', String(p));
		const s = params.toString();
		return s ? `?${s}` : '/admin/accounts';
	};
	const LAST_SEEN_HINT =
		'Latest session start or renewal. Sessions record no visits, and renew when used with under 15 days left, so the last visit may be up to 15 days later. — when no session is left.';
</script>

<svelte:head><title>Accounts · Admin</title></svelte:head>

<div class="space-y-6">
	<header class="space-y-1">
		<h1 class="text-xl font-semibold text-stone-100">Accounts</h1>
		<p class="text-sm text-stone-400">
			{data.total.toLocaleString('en')}
			{data.q ? `account${data.total === 1 ? '' : 's'} named like “${data.q}”` : `account${data.total === 1 ? '' : 's'}`}, newest first.
		</p>
	</header>

	{#if data.deleted}
		<p class="rounded-lg border border-emerald-800 bg-emerald-950/30 p-3 text-sm text-emerald-300" role="status">
			Deleted {data.deleted}, with its uploads. Its name stays held for 30 days.
		</p>
	{/if}

	<form method="GET" class="flex max-w-md gap-2" role="search">
		<label for="q" class="sr-only">Search by name</label>
		<input
			id="q"
			name="q"
			value={data.q}
			placeholder="Search by name"
			maxlength="64"
			class="min-w-0 flex-1 rounded border border-stone-700 bg-stone-900 px-3 py-1.5 text-sm text-stone-100 focus:border-amber-500 focus:outline-none"
		/>
		<button class="rounded bg-stone-800 px-3 py-1.5 text-sm text-stone-200 hover:bg-stone-700">Search</button>
		{#if data.q}<a href="/admin/accounts" class="self-center text-sm text-stone-400 hover:text-amber-300">Clear</a>{/if}
	</form>

	{#if !data.accounts.length}
		<p class="text-sm text-stone-500">{data.q ? 'No account has that in its name.' : 'No accounts yet.'}</p>
	{:else}
		<!-- Wide screens: a table. -->
		<table class="hidden w-full text-sm md:table">
			<thead>
				<tr class="text-left text-xs tracking-wide text-stone-500 uppercase">
					<th class="py-1 pr-4 font-medium">Name</th>
					<th class="py-1 pr-4 font-medium">Signs in with</th>
					<th class="py-1 pr-4 font-medium">Joined</th>
					<th class="py-1 pr-4 font-medium" title={LAST_SEEN_HINT}>Last seen ≈</th>
					<th class="py-1 pr-4 text-right font-medium">Sessions</th>
					<th class="py-1 pr-4 text-right font-medium" title="Live / processing / refused / failed">Uploads</th>
					<th class="py-1 pr-4 text-right font-medium" title="Screenshots waiting for approval">Screenshots</th>
					<th class="py-1 font-medium">State</th>
				</tr>
			</thead>
			<tbody class="divide-y divide-stone-800/70">
				{#each data.accounts as a (a.id)}
					<tr>
						<td class="py-1.5 pr-4"><a class="text-stone-100 hover:text-amber-300" href="/admin/accounts/{a.id}">{a.name}</a></td>
						<td class="py-1.5 pr-4 text-stone-300">{a.providers.join(', ') || '—'}</td>
						<td class="py-1.5 pr-4 text-stone-400 tabular-nums">{date(a.createdAt)}</td>
						<td class="py-1.5 pr-4 text-stone-400 tabular-nums">{date(a.lastSeen)}</td>
						<td class="py-1.5 pr-4 text-right tabular-nums {a.sessions ? 'text-stone-100' : 'text-stone-600'}">{a.sessions}</td>
						<td class="py-1.5 pr-4 text-right tabular-nums" title="Live / processing / refused / failed">
							<span class="text-emerald-400">{a.uploads.live}</span>
							<span class="text-stone-600">/</span>
							<span class={a.uploads.processing ? 'text-amber-400' : 'text-stone-600'}>{a.uploads.processing}</span>
							<span class="text-stone-600">/</span>
							<span class={a.uploads.refused ? 'text-red-400' : 'text-stone-600'}>{a.uploads.refused}</span>
							<span class="text-stone-600">/</span>
							<span class={a.uploads.failed ? 'text-red-400' : 'text-stone-600'}>{a.uploads.failed}</span>
						</td>
						<td class="py-1.5 pr-4 text-right tabular-nums {a.pendingScreenshots ? 'text-amber-300' : 'text-stone-600'}"
							>{a.pendingScreenshots}</td
						>
						<td class="py-1.5 text-xs">
							{#if a.deletingAt !== null}<span class="text-red-300" title="Deleting since {date(a.deletingAt)}">deleting</span>{/if}
							{#if a.bannedAt !== null}<span class="text-red-300">banned</span>{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>

		<!-- Phones: one card per account. -->
		<ul class="divide-y divide-stone-800 rounded border border-stone-800 md:hidden">
			{#each data.accounts as a (a.id)}
				<li class="space-y-1 px-3 py-2 text-sm">
					<div class="flex items-baseline justify-between gap-2">
						<a class="min-w-0 truncate text-stone-100 hover:text-amber-300" href="/admin/accounts/{a.id}">{a.name}</a>
						<span class="shrink-0 text-xs text-stone-500">{a.providers.join(', ') || '—'}</span>
					</div>
					<p class="text-xs text-stone-400">
						Joined {date(a.createdAt)} · seen ≈ {date(a.lastSeen)} · {a.sessions} session{a.sessions === 1 ? '' : 's'}
					</p>
					<p class="text-xs text-stone-400">
						Uploads {a.uploads.live} live, {a.uploads.processing} processing, {a.uploads.refused} refused, {a.uploads.failed} failed{a.pendingScreenshots
							? ` · ${a.pendingScreenshots} screenshot${a.pendingScreenshots === 1 ? '' : 's'} pending`
							: ''}
						{#if a.deletingAt !== null}<span class="text-red-300"> · deleting</span>{/if}
						{#if a.bannedAt !== null}<span class="text-red-300"> · banned</span>{/if}
					</p>
				</li>
			{/each}
		</ul>
	{/if}

	{#if data.pages > 1}
		<nav class="flex items-center gap-4 text-sm" aria-label="Pages">
			{#if data.page > 1}<a class="text-stone-300 hover:text-amber-300" href={pageHref(data.page - 1)}>‹ Newer</a>{/if}
			<span class="text-stone-500">Page {data.page} of {data.pages}</span>
			{#if data.page < data.pages}<a class="text-stone-300 hover:text-amber-300" href={pageHref(data.page + 1)}>Older ›</a>{/if}
		</nav>
	{/if}
</div>
