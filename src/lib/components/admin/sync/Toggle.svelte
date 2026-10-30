<script lang="ts">
	/** An on/off switch (a button with role="switch"); `onchange` after it flips. */
	let {
		checked = $bindable(),
		label,
		id,
		onchange
	}: { checked: boolean; label: string; id?: string; onchange?: (on: boolean) => void } = $props();
</script>

<button
	type="button"
	role="switch"
	{id}
	aria-checked={checked}
	aria-label={label}
	title={label}
	onclick={() => {
		checked = !checked;
		onchange?.(checked);
	}}
	class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 {checked
		? 'border-amber-500 bg-amber-500'
		: 'border-stone-600 bg-stone-800'}"
>
	<span class="inline-block size-4 rounded-full shadow transition-transform {checked ? 'translate-x-6 bg-stone-950' : 'translate-x-1 bg-stone-400'}"></span>
</button>
