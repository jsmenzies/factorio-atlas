<script lang="ts">
	import { onMount } from 'svelte';
	import PageMeta from '#lib/components/PageMeta.svelte';
	import { CONTACT_MAX, DETAILS_MAX, REMOVAL_REASONS } from '#lib/reports.js';
	import { plainText } from '#lib/richtext.js';

	let { data, form } = $props();

	const title = $derived(plainText(data.title));
	let widget: HTMLDivElement | undefined = $state();

	type Turnstile = { render: (el: HTMLElement, options: { sitekey: string; theme: 'dark' }) => string };
	const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

	// Turnstile's widget, rendered explicitly so it also appears after a client-side navigation. It puts
	// its token in a hidden `cf-turnstile-response` field inside the form. A plain POST (no enhance)
	// reloads the page, which renders a fresh widget for another try.
	onMount(() => {
		const siteKey = data.siteKey;
		if (!siteKey || !widget || form?.sent) return;
		const el = widget;
		const render = () => (window as unknown as { turnstile: Turnstile }).turnstile.render(el, { sitekey: siteKey, theme: 'dark' });
		if ('turnstile' in window) return void render();
		const script = document.createElement('script');
		script.src = SCRIPT;
		script.async = true;
		script.onload = render;
		document.head.appendChild(script);
	});
</script>

<PageMeta title="Request removal: {title} · Blueprint Atlas" description="Ask for {title} to be removed from Blueprint Atlas." noindex />

<div class="mx-auto max-w-xl space-y-6 py-10">
	<header class="space-y-2">
		<p class="text-sm"><a class="text-stone-400 hover:text-amber-300" href="/prints/{data.id}">← {title}</a></p>
		<h1 class="text-2xl font-semibold text-stone-100">Request removal</h1>
		<p class="text-sm text-stone-400">
			Ask us to take <span class="text-stone-200">{title}</span>{#if data.author}&nbsp;by {data.author}{/if} off Blueprint Atlas. We read every
			request; if we agree, the blueprint, its screenshot and its renders are deleted here and never copied again.
		</p>
	</header>

	{#if form?.sent}
		<div class="space-y-2 rounded-lg border border-emerald-800 bg-emerald-950/40 p-4 text-sm text-stone-200">
			<p class="font-medium text-emerald-300">Thanks, we have your request.</p>
			<p class="text-stone-400">
				We’ll look at it soon. Blueprint Atlas copies prints from factorioprints.com, which keeps its own copy: to remove it there too, ask on
				that site.
			</p>
		</div>
	{:else if !data.siteKey}
		<p class="rounded-lg border border-stone-800 p-4 text-sm text-stone-400">Removal requests are not available right now.</p>
	{:else}
		<form method="POST" class="space-y-5">
			<fieldset class="space-y-2">
				<legend class="mb-2 text-sm font-medium text-stone-200">Why should it be removed?</legend>
				{#each Object.entries(REMOVAL_REASONS) as [value, label] (value)}
					<label class="flex items-center gap-2 text-sm text-stone-300">
						<input type="radio" name="reason" {value} checked={form?.reason === value} required class="accent-amber-500" />
						{label}
					</label>
				{/each}
			</fieldset>

			<label class="block space-y-1 text-sm">
				<span class="font-medium text-stone-200">Details</span>
				<span class="block text-stone-500">Optional, unless you chose “Something else”. If it’s your work posted by someone else, say where you posted it.</span>
				<textarea
					name="details"
					rows="5"
					maxlength={DETAILS_MAX}
					class="w-full rounded border border-stone-700 bg-stone-900 px-3 py-2 text-stone-100 focus:border-amber-500 focus:outline-none"
					>{form?.details ?? ''}</textarea
				>
			</label>

			<label class="block space-y-1 text-sm">
				<span class="font-medium text-stone-200">How to reach you</span>
				<span class="block text-stone-500">Optional: an email or Discord name, in case we have a question. Deleted 30 days after we decide.</span>
				<input
					name="contact"
					maxlength={CONTACT_MAX}
					value={form?.contact ?? ''}
					autocomplete="email"
					class="w-full rounded border border-stone-700 bg-stone-900 px-3 py-2 text-stone-100 focus:border-amber-500 focus:outline-none"
				/>
			</label>

			<div bind:this={widget} class="min-h-[65px]"></div>

			{#if form?.error}<p class="text-sm text-red-400" role="alert">{form.error}</p>{/if}

			<button type="submit" class="rounded bg-amber-500 px-4 py-2 text-sm font-medium text-stone-950 hover:bg-amber-400">Send request</button>
		</form>
	{/if}
</div>
