<script lang="ts">
	import { onMount } from 'svelte';

	/**
	 * Cloudflare Turnstile's widget (lib/server/turnstile.ts checks its token), rendered explicitly so it
	 * also appears after a client-side navigation. It puts its token in a hidden `cf-turnstile-response`
	 * field of the form it sits in. A plain POST (no enhance) reloads the page, which renders a fresh
	 * widget for another try.
	 */
	let { siteKey }: { siteKey: string } = $props();
	let widget: HTMLDivElement | undefined = $state();

	type Turnstile = { render: (el: HTMLElement, options: { sitekey: string; theme: 'dark' }) => string };
	const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

	onMount(() => {
		if (!widget) return;
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

<div bind:this={widget} class="min-h-[65px]"></div>
