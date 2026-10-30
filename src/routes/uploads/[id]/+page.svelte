<script lang="ts">
	import PageMeta from '#lib/components/PageMeta.svelte';
	import UploadFields from '#lib/components/upload/UploadFields.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const u = $derived(data.upload);
	const values = $derived(form && 'title' in form ? form : data.values);
	let imageAction = $state('keep');
	const REFUSED: Record<string, string> = {
		blocked: 'This blueprint can’t be uploaded.',
		undecodable: 'Its blueprint string can’t be read. Paste it again below.',
		duplicate: 'The same blueprint is already on Blueprint Atlas.'
	};
	const IMAGE: Record<string, string> = {
		pending: 'Screenshot waiting to be checked.',
		approved: 'Screenshot approved. It shows on the print after the next update, usually within a day.',
		shown: 'Screenshot approved.',
		rejected: 'Screenshot not approved. You can replace it below with another one.'
	};
</script>

<PageMeta title="{data.values.title} · Your upload · Blueprint Atlas" description="One of your uploads." noindex />

<div class="mx-auto max-w-2xl space-y-8 py-10">
	<header class="space-y-3">
		<p class="text-sm"><a class="text-stone-400 hover:text-amber-300" href="/account">← Your account</a></p>
		<h1 class="text-2xl font-semibold text-stone-100">{data.values.title}</h1>
		{#if u.state === 'live'}
			<p class="text-sm text-emerald-300">On the site: <a class="underline" href="/prints/{u.id}">/prints/{u.id}</a></p>
		{:else if u.state === 'processing'}
			<div class="space-y-1 rounded-lg border border-amber-800/60 bg-amber-950/30 p-3 text-sm text-stone-300" role="status">
				<p class="font-medium text-amber-300">{data.sent ? 'Uploaded. ' : ''}Processing</p>
				<p>
					{u.tooBig
						? 'It’s too big to add straight away, so it goes on the site with the next update, usually within a day.'
						: 'It goes on the site with the next update, usually within a day.'}
					{#if u.live}The version on the site stays until then.{/if}
				</p>
			</div>
		{:else if u.state === 'failed'}
			<div class="space-y-1 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-stone-300" role="alert">
				<p class="font-medium text-red-300">Couldn’t be processed</p>
				<p>
					It couldn’t be processed: {u.failure ?? 'an error on our side'}. Save it again below to have another go, or delete it.
					{#if u.live}The version on the site stays as it was.{/if}
				</p>
			</div>
		{:else}
			<div class="space-y-1 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-stone-300" role="alert">
				<p class="font-medium text-red-300">Not added</p>
				<p>
					{REFUSED[u.refusedReason ?? ''] ?? 'It couldn’t be added.'}
					{#if u.refusedPrintId}<a class="text-amber-300 underline" href="/prints/{u.refusedPrintId}">See it</a>{/if}
				</p>
			</div>
		{/if}
		{#if u.image === 'rejected'}
			<p class="text-sm text-amber-300" role="status">{IMAGE.rejected}</p>
		{:else if u.image}<p class="text-sm text-stone-500">{IMAGE[u.image === 'approved' && u.imageShown ? 'shown' : u.image]}</p>{/if}
	</header>

	<form method="POST" action="?/save" enctype="multipart/form-data" class="space-y-5">
		<h2 class="text-lg font-medium text-stone-200">Edit</h2>
		<UploadFields limits={data.limits} {values} edit />
		<fieldset class="space-y-2 text-sm">
			<legend class="mb-1 font-medium text-stone-200">Screenshot</legend>
			{#each [['keep', u.image ? 'Keep it' : 'None'], ...(u.image ? [['remove', 'Remove it']] : []), ['replace', u.image ? 'Replace it' : 'Add one']] as [value, label] (value)}
				<label class="mr-4 inline-flex items-center gap-2 text-stone-300">
					<input type="radio" name="image_action" {value} bind:group={imageAction} class="accent-amber-500" />{label}
				</label>
			{/each}
			{#if imageAction === 'replace'}
				<input type="file" name="image" required accept="image/png,image/jpeg,image/webp,image/gif" class="block text-stone-300" />
				<span class="block text-stone-500">PNG, JPEG, WebP or GIF, up to {data.limits.imageMb} MB. It shows once we’ve checked it.</span>
			{/if}
		</fieldset>
		{#if form && 'problem' in form && form.problem}
			<p class="text-sm text-red-300" role="alert">
				{form.problem}
				{#if form.existing}<a class="text-amber-300 underline" href="/prints/{form.existing.printId}">See it</a>{/if}
			</p>
		{/if}
		{#if form && 'saved' in form}
			<p class="text-sm text-emerald-300" role="status">{form.saved === 'live' ? 'Saved.' : 'Saved. The changes go on the site with the next update.'}</p>
		{/if}
		<button type="submit" class="rounded bg-amber-500 px-4 py-2 text-sm font-medium text-stone-950 hover:bg-amber-400">Save</button>
	</form>

	<details class="rounded border border-stone-800 p-4">
		<summary class="cursor-pointer text-sm text-stone-400">Delete this upload</summary>
		<form method="POST" action="?/delete" class="mt-3 space-y-3">
			<p class="text-sm text-stone-400">It comes off the site, with its screenshot and renders. It can’t be undone.</p>
			<label class="flex items-center gap-2 text-sm text-stone-300"><input type="checkbox" name="confirm" value="yes" required /> Yes, delete it</label>
			{#if form && 'deleteProblem' in form}<p class="text-sm text-red-300" role="alert">{form.deleteProblem}</p>{/if}
			<button class="rounded bg-red-900/60 px-4 py-2 text-red-100 hover:bg-red-900">Delete upload</button>
		</form>
	</details>
</div>
