<script lang="ts">
	/** The fields an upload and its edit share (routes/upload, routes/uploads/[id]). */
	let {
		limits,
		values,
		edit = false
	}: {
		limits: { title: number; description: number; imageMb: number };
		values?: { title?: string; description?: string; string?: string };
		/** On an edit an empty string keeps the current one. */
		edit?: boolean;
	} = $props();

	const field = 'w-full rounded border border-stone-700 bg-stone-900 px-3 py-2 text-stone-100 focus:border-amber-500 focus:outline-none';
</script>

<label class="block space-y-1 text-sm">
	<span class="font-medium text-stone-200">Title</span>
	<input name="title" required maxlength={limits.title} value={values?.title ?? ''} class={field} />
</label>

<label class="block space-y-1 text-sm">
	<span class="font-medium text-stone-200">Blueprint string</span>
	<span class="block text-stone-500">
		{edit ? 'Paste a new string to replace the blueprint, or leave this empty to keep it.' : 'In Factorio: open the blueprint, Export to string, then paste it here.'}
	</span>
	<textarea name="string" rows="5" required={!edit} spellcheck="false" class="{field} font-mono text-xs break-all">{values?.string ?? ''}</textarea>
</label>

<label class="block space-y-1 text-sm">
	<span class="font-medium text-stone-200">Description</span>
	<span class="block text-stone-500">Optional. Markdown: how to use it, what it needs, rates.</span>
	<textarea name="description" rows="8" maxlength={limits.description} class={field}>{values?.description ?? ''}</textarea>
</label>

{#if !edit}
	<label class="block space-y-1 text-sm">
		<span class="font-medium text-stone-200">Screenshot</span>
		<span class="block text-stone-500">Optional. PNG, JPEG, WebP or GIF, up to {limits.imageMb} MB. It shows once we’ve checked it.</span>
		<input type="file" name="image" accept="image/png,image/jpeg,image/webp,image/gif" class="block text-stone-300" />
	</label>
{/if}
