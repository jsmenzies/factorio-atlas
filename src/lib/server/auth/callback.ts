/**
 * The provider sends the browser back to /auth/<provider>/callback (its route is a thin wrapper over
 * this). Only a `state` matching this browser's flow cookie is accepted; then the code becomes a
 * token, the token a profile, and the profile an account and a session (ending the browser's previous
 * session, if it had one). Anything that goes wrong lands on /login with a short reason (`?error=`).
 * A new account goes to /account first, to check the name it was given. Either way the URL carries the
 * provider in its fragment, for the browser to remember (lib/last-sign-in.ts).
 */
import type { Cookies } from '@sveltejs/kit';
import { withSignInMark } from '#lib/last-sign-in.js';
import { sessionToken, setSessionCookies, takeFlowCookie } from './cookies';
import { exchangeCode } from './oauth';
import { isProvider, providerClient, SPECS, type Profile, type ProviderVars } from './providers';
import { createSession } from './sessions';
import { signInAccount } from './users';

export interface CallbackDeps {
	db: D1Database;
	vars: ProviderVars;
	cookies: Cookies;
	dev: boolean;
	fetcher?: typeof fetch;
	now?: number;
}

/** Where to send the browser next, or null for a 404 (no such provider on this stage). */
export const finishSignIn = async (provider: string, url: URL, deps: CallbackDeps): Promise<string | null> => {
	const { db, cookies, dev, fetcher = fetch, now = Date.now() } = deps;
	const client = isProvider(provider) ? providerClient(deps.vars, provider) : null;
	if (!isProvider(provider) || !client) return null;
	const flow = takeFlowCookie(cookies, dev);
	const back = (reason: string) => `/login?error=${reason}&return=${encodeURIComponent(flow?.returnTo ?? '/')}`;

	// The visitor said no at the provider, or it refused.
	if (url.searchParams.has('error')) return back('cancelled');
	const code = url.searchParams.get('code');
	if (!flow || flow.provider !== provider || flow.state !== url.searchParams.get('state') || !code) return back('expired');

	let profile: Profile;
	try {
		profile = await SPECS[provider].profile(await exchangeCode(flow, code, client, url.origin, fetcher), fetcher);
	} catch (e) {
		console.warn(`auth: ${provider} sign-in failed: ${e instanceof Error ? e.message : String(e)}`);
		return back('provider');
	}
	const result = await signInAccount(db, provider, profile, now);
	if (!result.ok) return back('banned');
	const session = await createSession(db, result.account.id, now, sessionToken(cookies, dev));
	setSessionCookies(cookies, session.token, session.expiresAt, dev);
	return withSignInMark(result.created ? `/account?welcome=1&return=${encodeURIComponent(flow.returnTo)}` : flow.returnTo, provider);
};
