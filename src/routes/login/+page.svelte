<script lang="ts">
	import PageMeta from '#lib/components/PageMeta.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const returnParam = $derived(encodeURIComponent(data.returnTo));
</script>

<PageMeta title="Sign in · Blueprint Atlas" description="Sign in to Blueprint Atlas to upload your Factorio blueprints." noindex />

<div class="mx-auto max-w-sm space-y-6 py-12">
	<h1 class="text-2xl font-semibold text-stone-100">Sign in</h1>
	{#if data.error}
		<p class="rounded border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-200" role="alert">{data.error}</p>
	{/if}
	{#if data.providers.length > 0 || data.devSignIn}
		<div class="flex flex-col gap-2">
			<!-- Full page loads: these leave the site for the provider's own page. -->
			{#each data.providers as p (p.id)}
				<a
					class="rounded bg-stone-800 px-4 py-2.5 text-center text-stone-100 hover:bg-stone-700"
					href="/auth/{p.id}?return={returnParam}"
					data-sveltekit-reload>Continue with {p.label}</a
				>
			{/each}
			{#if data.devSignIn}
				<a
					class="rounded border border-dashed border-stone-700 px-4 py-2.5 text-center text-stone-400 hover:text-amber-300"
					href="/auth/dev?return={returnParam}"
					data-sveltekit-reload>Test account (vite dev only)</a
				>
			{/if}
		</div>
	{:else}
		<p class="text-stone-400">Signing in isn’t available yet.</p>
	{/if}
	<p class="text-sm text-stone-400">
		We keep only your account’s id at the service you choose and a display name you can change. No email address, no password.
	</p>
</div>
