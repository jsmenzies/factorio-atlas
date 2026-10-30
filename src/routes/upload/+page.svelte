<script lang="ts">
	import PageMeta from '#lib/components/PageMeta.svelte';
	import Turnstile from '#lib/components/Turnstile.svelte';
	import UploadFields from '#lib/components/upload/UploadFields.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<PageMeta title="Upload a blueprint · Blueprint Atlas" description="Upload a Factorio blueprint to Blueprint Atlas." noindex />

<div class="mx-auto max-w-2xl space-y-6 py-10">
	<header class="space-y-2">
		<h1 class="text-2xl font-semibold text-stone-100">Upload a blueprint</h1>
		<p class="text-sm text-stone-400">
			It goes on the site at once, under your name, <span class="text-stone-200">{data.name}</span>. A screenshot shows once we’ve checked it.
			You can edit or delete it from <a class="text-amber-300 hover:underline" href="/account">your account</a>.
		</p>
	</header>

	{#if !data.siteKey}
		<p class="rounded-lg border border-stone-800 p-4 text-sm text-stone-400">Uploads are not available right now.</p>
	{:else}
		<form method="POST" enctype="multipart/form-data" class="space-y-5">
			<UploadFields limits={data.limits} values={form ?? undefined} />
			<Turnstile siteKey={data.siteKey} />
			{#if form?.problem}
				<p class="text-sm text-red-300" role="alert">
					{form.problem}
					{#if form.existing?.own}
						<a class="text-amber-300 underline" href="/uploads/{form.existing.printId}">Edit it</a>
					{:else if form.existing}
						<a class="text-amber-300 underline" href="/prints/{form.existing.printId}">See it</a>
					{/if}
				</p>
			{/if}
			<p class="text-xs text-stone-500">
				Up to {data.limits.perDay} uploads a day. Only upload your own work, or work you have the right to share.
			</p>
			<button type="submit" class="rounded bg-amber-500 px-4 py-2 text-sm font-medium text-stone-950 hover:bg-amber-400">Upload</button>
		</form>
	{/if}
</div>
