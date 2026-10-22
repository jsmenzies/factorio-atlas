<script lang="ts">
	import { page } from '$app/state';
	import type { LayoutProps } from './$types';

	// Private (Cloudflare Access; see hooks.server.ts). Nothing on the public site links here.
	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<nav class="mb-6 flex items-center gap-3 text-sm" aria-label="Admin">
	<span class="rounded bg-stone-800 px-1.5 py-0.5 text-xs font-medium tracking-wide text-stone-400 uppercase">Admin</span>
	<a
		href="/admin/pipeline"
		class={page.url.pathname.startsWith('/admin/pipeline') ? 'text-stone-100' : 'text-stone-400 hover:text-amber-300'}
		aria-current={page.url.pathname === '/admin/pipeline' ? 'page' : undefined}>Pipeline</a
	>
	<a
		href="/admin/render"
		class={page.url.pathname.startsWith('/admin/render') ? 'text-stone-100' : 'text-stone-400 hover:text-amber-300'}
		aria-current={page.url.pathname === '/admin/render' ? 'page' : undefined}>Render</a
	>
</nav>

{@render children()}
