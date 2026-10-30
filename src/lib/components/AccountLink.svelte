<script lang="ts">
	import { page } from '$app/state';

	/**
	 * "Sign in", or the signed-in account's name, in the header. Pages are cached for everyone, so the
	 * server never says who is signed in: app.html sets `<html data-auth="in">` from the hint cookie
	 * before the page draws (CSS shows the right link), and this asks /me for the name. A stale hint
	 * (an expired session) switches back to "Sign in"; /me's answer has already cleared the cookie.
	 */
	let name = $state<string | null>(null);

	$effect(() => {
		if (document.documentElement.dataset.auth !== 'in') return;
		fetch('/me')
			.then((res) => (res.ok ? (res.json() as Promise<{ account: { name: string } | null }>) : null))
			.then((body) => {
				if (body?.account) name = body.account.name;
				else if (body) delete document.documentElement.dataset.auth;
			})
			.catch(() => {});
	});

	// Back to this page afterwards; never back to the sign-in page itself.
	const signIn = $derived(
		page.url.pathname === '/login' ? page.url.pathname + page.url.search : `/login?return=${encodeURIComponent(page.url.pathname + page.url.search)}`
	);
</script>

<a href={signIn} class="auth-out text-sm text-stone-400 hover:text-amber-300" rel="nofollow">Sign in</a>
<a href="/upload" class="auth-in text-sm text-stone-400 hover:text-amber-300" rel="nofollow">Upload</a>
<a href="/account" class="auth-in max-w-40 truncate text-sm text-stone-300 hover:text-amber-300" rel="nofollow">{name ?? 'Account'}</a>
