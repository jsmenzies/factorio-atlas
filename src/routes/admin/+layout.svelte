<script lang="ts">
	import { dev } from '$app/env';
	import { page } from '$app/state';
	import type { LayoutProps } from './$types';

	// Private (Cloudflare Access; see hooks.server.ts). Nothing on the public site links here.
	let { children }: LayoutProps = $props();

	/**
	 * The tabs. Overview and Update run on this machine only (`vite dev`); there, the pipeline and render
	 * pages are the Update tab's detail pages (its steps link to their runs). Deployed, /admin is the
	 * pipeline page, so it keeps its tab.
	 */
	const tabs = $derived([
		...(dev
			? [
					{ href: '/admin', label: 'Overview', active: (p: string) => p === '/admin' },
					{
						href: '/admin/update',
						label: 'Update',
						active: (p: string) => ['/admin/update', '/admin/pipeline', '/admin/render'].some((t) => p === t || p.startsWith(`${t}/`))
					}
				]
			: [{ href: '/admin/pipeline', label: 'Pipeline', active: (p: string) => p.startsWith('/admin/pipeline') }]),
		{ href: '/admin/reports', label: 'Reports', active: (p: string) => p.startsWith('/admin/reports') },
		{ href: '/admin/screenshots', label: 'Screenshots', active: (p: string) => p.startsWith('/admin/screenshots') },
		{ href: '/admin/add', label: 'Add', active: (p: string) => p.startsWith('/admin/add') },
		{ href: '/admin/accounts', label: 'Accounts', active: (p: string) => p.startsWith('/admin/accounts') }
	]);
</script>

<svelte:head>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<nav class="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" aria-label="Admin">
	<span class="rounded bg-stone-800 px-1.5 py-0.5 text-xs font-medium tracking-wide text-stone-400 uppercase">Admin</span>
	{#each tabs as t (t.href)}
		{@const active = t.active(page.url.pathname)}
		<a
			href={t.href}
			class={active ? 'text-stone-100' : 'text-stone-400 hover:text-amber-300'}
			aria-current={page.url.pathname === t.href ? 'page' : undefined}>{t.label}</a
		>
	{/each}
</nav>

{@render children()}
