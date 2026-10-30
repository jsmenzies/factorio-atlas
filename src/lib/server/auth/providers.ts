/**
 * The sign-in providers: plain OAuth 2.0 authorization-code flows with PKCE, run by the Worker
 * (routes/auth). Each asks only for the user's id (and Discord's and GitHub's public handle); the site
 * keeps the id and a display name made from the handle, and drops the provider's token as soon as the
 * profile is read.
 *
 * A provider is on when its client id and secret are set (wrangler.jsonc vars and Worker secrets,
 * from .env through alchemy.run.ts; docs/deploy.md, "Sign-in"). Each app's redirect URL is
 * `<origin>/auth/<provider>/callback`.
 */

export const PROVIDERS = ['discord', 'github', 'google'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const isProvider = (s: string): s is Provider => (PROVIDERS as readonly string[]).includes(s);

/** Who signed in, as the provider says: its permanent user id and a name to start the account's name from. */
export interface Profile {
	subject: string;
	name: string;
}

interface ProviderSpec {
	label: string;
	authorize: string;
	token: string;
	scope: string;
	/** Reads the profile with the access token. */
	profile: (token: string, fetcher: typeof fetch) => Promise<Profile>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** GETs a provider's JSON with the access token; throws on anything but a 2xx JSON object. */
const getJson = async (url: string, token: string, fetcher: typeof fetch) => {
	const res = await fetcher(url, {
		headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': 'factorio-atlas' }
	});
	if (!res.ok) throw new Error(`${new URL(url).host} profile: HTTP ${res.status}`);
	const body: unknown = await res.json();
	if (!isRecord(body)) throw new Error(`${new URL(url).host} profile: not an object`);
	return body;
};

const subjectOf = (v: unknown) => {
	const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : str(v);
	if (s === undefined) throw new Error('profile has no user id');
	return s;
};

export const SPECS: Record<Provider, ProviderSpec> = {
	discord: {
		label: 'Discord',
		authorize: 'https://discord.com/oauth2/authorize',
		token: 'https://discord.com/api/oauth2/token',
		scope: 'identify',
		profile: async (token, fetcher) => {
			const u = await getJson('https://discord.com/api/users/@me', token, fetcher);
			// The public handle (`username`: a-z, 0-9, `_` and `.`), not the free-form display name.
			return { subject: subjectOf(u.id), name: str(u.username) ?? '' };
		}
	},
	github: {
		label: 'GitHub',
		authorize: 'https://github.com/login/oauth/authorize',
		token: 'https://github.com/login/oauth/access_token',
		// No scope: public profile only.
		scope: '',
		profile: async (token, fetcher) => {
			const u = await getJson('https://api.github.com/user', token, fetcher);
			return { subject: subjectOf(u.id), name: str(u.login) ?? '' };
		}
	},
	google: {
		label: 'Google',
		authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
		token: 'https://oauth2.googleapis.com/token',
		// The user id only: Google names are usually people's real names, so a new account is
		// "Engineer NNNN" (users.ts, freeName) until its owner picks a name. No `profile`, no `email`.
		scope: 'openid',
		profile: async (token, fetcher) => {
			const u = await getJson('https://openidconnect.googleapis.com/v1/userinfo', token, fetcher);
			return { subject: subjectOf(u.sub), name: '' };
		}
	}
};

/** The client id and secret variables of each provider. */
export interface ProviderVars {
	DISCORD_CLIENT_ID?: string;
	DISCORD_CLIENT_SECRET?: string;
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
}

export interface Client {
	id: string;
	secret: string;
}

/** A provider's app credentials, or null when it isn't set up on this stage. */
export const providerClient = (vars: ProviderVars, p: Provider): Client | null => {
	const key = p.toUpperCase() as 'DISCORD' | 'GITHUB' | 'GOOGLE';
	const id = vars[`${key}_CLIENT_ID`]?.trim();
	const secret = vars[`${key}_CLIENT_SECRET`]?.trim();
	return id && secret ? { id, secret } : null;
};

/** The providers set up on this stage, in display order. */
export const enabledProviders = (vars: ProviderVars) => PROVIDERS.filter((p) => providerClient(vars, p) !== null);
