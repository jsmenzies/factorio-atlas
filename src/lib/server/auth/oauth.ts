/**
 * The OAuth round trip (routes/auth/[provider] and its callback). The start sends the browser to the
 * provider with a random `state` and a PKCE challenge, and keeps both, the provider and where to go
 * afterwards in a short-lived HttpOnly cookie. The callback accepts only a code whose `state`
 * matches that cookie, so nobody can sign a visitor in to an account of theirs, and exchanges it
 * with the verifier.
 */
import { SPECS, type Client, type Provider } from './providers';

/** How long a sign-in may take at the provider. */
export const FLOW_MAX_AGE_S = 600;

export interface Flow {
	provider: Provider;
	state: string;
	verifier: string;
	/** A path on this site (safeReturn). */
	returnTo: string;
}

export const base64url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');

/** `n` random bytes, base64url. */
export const randomToken = (n = 32) => base64url(crypto.getRandomValues(new Uint8Array(n)));

/** PKCE S256: base64url(SHA-256(verifier)). */
export const challengeOf = async (verifier: string) =>
	base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));

/** Any origin will do: safeReturn only asks whether a value stays on the one it is resolved against. */
const BASE = 'https://atlas.invalid';

/**
 * Where to send the browser after signing in: a path on this site, else the home page. The value is
 * resolved as a browser would (`new URL(value, origin)`), so anything that leaves the origin
 * (`//host`, `/\host`, a scheme) is refused, and what comes back is the URL's own path, query and
 * hash, percent-encoded (a raw non-Latin-1 character can't go in a Location header). The sign-in
 * routes themselves are refused too.
 */
export const safeReturn = (value: string | null | undefined) => {
	if (!value || value.length > 1000 || !value.startsWith('/')) return '/';
	let url: URL;
	try {
		url = new URL(value, BASE);
	} catch {
		return '/';
	}
	if (url.origin !== BASE) return '/';
	const p = url.pathname;
	if (p === '/auth' || p.startsWith('/auth/') || p === '/login' || p.startsWith('/login/')) return '/';
	const result = p + url.search + url.hash;
	// Dot segments collapse after the origin check (`/.//evil.com` → `//evil.com`), and a path starting with
	// two slashes is another host to the browser: check what goes out, resolved again.
	if (/^\/[/\\]/.test(result) || new URL(result, BASE).origin !== BASE) return '/';
	return result;
};

export const newFlow = (provider: Provider, returnTo: string | null): Flow => ({
	provider,
	state: randomToken(),
	verifier: randomToken(48),
	returnTo: safeReturn(returnTo)
});

/** The flow cookie's value. */
export const encodeFlow = (flow: Flow) => base64url(new TextEncoder().encode(JSON.stringify(flow)));

/** The flow from its cookie, or null when it's missing or not one of ours. */
export const decodeFlow = (value: string | undefined): Flow | null => {
	if (!value) return null;
	try {
		const b64 = value.replaceAll('-', '+').replaceAll('_', '/');
		const text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
		const f = JSON.parse(text) as Partial<Flow>;
		if (typeof f.provider !== 'string' || !(f.provider in SPECS)) return null;
		if (typeof f.state !== 'string' || typeof f.verifier !== 'string' || typeof f.returnTo !== 'string') return null;
		return { provider: f.provider as Provider, state: f.state, verifier: f.verifier, returnTo: safeReturn(f.returnTo) };
	} catch {
		return null;
	}
};

export const redirectUri = (origin: string, provider: Provider) => `${origin}/auth/${provider}/callback`;

/** The provider's sign-in page for this flow. */
export const authorizeUrl = async (flow: Flow, client: Client, origin: string) => {
	const spec = SPECS[flow.provider];
	const url = new URL(spec.authorize);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', client.id);
	url.searchParams.set('redirect_uri', redirectUri(origin, flow.provider));
	if (spec.scope) url.searchParams.set('scope', spec.scope);
	url.searchParams.set('state', flow.state);
	url.searchParams.set('code_challenge', await challengeOf(flow.verifier));
	url.searchParams.set('code_challenge_method', 'S256');
	return url.toString();
};

/** Swaps the callback's code for an access token. Throws on any refusal. */
export const exchangeCode = async (flow: Flow, code: string, client: Client, origin: string, fetcher: typeof fetch = fetch) => {
	const res = await fetcher(SPECS[flow.provider].token, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'factorio-atlas' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri(origin, flow.provider),
			client_id: client.id,
			client_secret: client.secret,
			code_verifier: flow.verifier
		})
	});
	const body = (await res.json().catch(() => null)) as { access_token?: unknown; error?: unknown } | null;
	// GitHub answers 200 with an `error` field.
	if (!res.ok || typeof body?.access_token !== 'string') {
		throw new Error(`${flow.provider} token: HTTP ${res.status}${typeof body?.error === 'string' ? ` ${body.error}` : ''}`);
	}
	return body.access_token;
};
