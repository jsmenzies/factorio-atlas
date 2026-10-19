/**
 * Cloudflare Access JWT verification for /admin (docs/deploy.md, "Admin page").
 *
 * Access sits in front of `<host>/admin*` and adds a signed JWT to every request it lets
 * through (`Cf-Access-Jwt-Assertion`). The Worker checks it too, so a request that reaches the
 * Worker without passing Access (a misconfigured path, the workers.dev URL, a missing app) is
 * refused. RS256 with WebCrypto against the team's public keys, which are cached per isolate.
 */

export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

export interface AccessConfig {
	/** `https://<team>.cloudflareaccess.com`: the token's `iss`, and where the certs live. */
	issuer: string;
	/** The Access application's audience tag. */
	aud: string;
}

export interface AccessIdentity {
	sub: string;
	email?: string;
}

export type AccessResult = { ok: true; identity: AccessIdentity } | { ok: false; reason: string };

/** Looks up a verification key by `kid`; null when the team has no such key. */
export type KeyLookup = (kid: string) => Promise<CryptoKey | null>;

/** Clock skew allowed on `exp` and `nbf`. */
const LEEWAY_S = 30;

/**
 * Reads ACCESS_TEAM_DOMAIN (`<team>.cloudflareaccess.com`, with or without `https://`) and
 * ACCESS_AUD. Null when either is missing, which callers treat as "admin is off" (fail closed).
 */
export const accessConfig = (vars: { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string }): AccessConfig | null => {
	const team = vars.ACCESS_TEAM_DOMAIN?.trim()
		.replace(/^https?:\/\//, '')
		.replace(/\/.*$/, '')
		.toLowerCase();
	const aud = vars.ACCESS_AUD?.trim();
	if (!team || !aud) return null;
	return { issuer: `https://${team}`, aud };
};

const base64url = (s: string) => {
	const b64 = s.replaceAll('-', '+').replaceAll('_', '/');
	return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const json = (s: string): unknown => JSON.parse(new TextDecoder().decode(base64url(s)));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Verifies an Access JWT: RS256 signature by a team key, `iss`, `aud`, `exp` and `nbf`. */
export const verifyAccessJwt = async (token: string, config: AccessConfig, keys: KeyLookup, now = Date.now()): Promise<AccessResult> => {
	const parts = token.split('.');
	if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
	const [h, p, s] = parts;
	let header: unknown;
	let payload: unknown;
	let signature: Uint8Array<ArrayBuffer>;
	try {
		header = json(h);
		payload = json(p);
		signature = base64url(s);
	} catch {
		return { ok: false, reason: 'malformed token' };
	}
	if (!isRecord(header) || !isRecord(payload)) return { ok: false, reason: 'malformed token' };
	// Only RS256: never trust the token to pick a weaker algorithm (`none`, HS256 with the public key).
	if (header.alg !== 'RS256') return { ok: false, reason: `unexpected alg ${String(header.alg)}` };
	if (typeof header.kid !== 'string') return { ok: false, reason: 'no kid' };
	const key = await keys(header.kid);
	if (!key) return { ok: false, reason: `unknown kid ${header.kid}` };
	const signed = new TextEncoder().encode(`${h}.${p}`);
	if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed))) return { ok: false, reason: 'bad signature' };

	if (payload.iss !== config.issuer) return { ok: false, reason: `wrong iss ${String(payload.iss)}` };
	const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
	if (!aud.includes(config.aud)) return { ok: false, reason: 'wrong aud' };
	const nowS = now / 1000;
	if (typeof payload.exp !== 'number' || payload.exp + LEEWAY_S < nowS) return { ok: false, reason: 'expired' };
	if (typeof payload.nbf === 'number' && payload.nbf - LEEWAY_S > nowS) return { ok: false, reason: 'not yet valid' };
	if (typeof payload.sub !== 'string') return { ok: false, reason: 'no sub' };
	return { ok: true, identity: { sub: payload.sub, email: typeof payload.email === 'string' ? payload.email : undefined } };
};

interface KeySet {
	keys: Map<string, CryptoKey>;
	fetchedAt: number;
}
const sharedKeyCache = new Map<string, KeySet>();

/** Keys are re-fetched after this, or sooner when a token names a kid we don't have (rotation). */
const KEYS_TTL_MS = 60 * 60_000;
/** But not more often than this, so junk kids can't make every request fetch the certs. */
const KEYS_MIN_REFETCH_MS = 30_000;

/**
 * A cached key lookup for a team's `/cdn-cgi/access/certs`. One cache per issuer, kept for the
 * isolate's life; pass a cache map to isolate tests.
 */
export const teamKeys = (issuer: string, fetcher: typeof fetch = fetch, cache = sharedKeyCache): KeyLookup => {
	const load = async (now: number) => {
		const res = await fetcher(`${issuer}/cdn-cgi/access/certs`);
		if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
		const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
		const keys = new Map<string, CryptoKey>();
		for (const jwk of body.keys ?? []) {
			if (jwk.kty !== 'RSA' || !jwk.kid) continue;
			const { kid, ...rest } = jwk;
			keys.set(kid, await crypto.subtle.importKey('jwk', rest, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
		}
		const set = { keys, fetchedAt: now };
		cache.set(issuer, set);
		return set;
	};
	return async (kid) => {
		const now = Date.now();
		let set = cache.get(issuer);
		if (!set || now - set.fetchedAt > KEYS_TTL_MS || (!set.keys.has(kid) && now - set.fetchedAt > KEYS_MIN_REFETCH_MS)) {
			set = await load(now);
		}
		return set.keys.get(kid) ?? null;
	};
};

/** Verifies a request's Access token against the configured team and application. */
export const verifyAccessRequest = async (request: Request, config: AccessConfig, fetcher: typeof fetch = fetch): Promise<AccessResult> => {
	const token = request.headers.get(ACCESS_JWT_HEADER);
	if (!token) return { ok: false, reason: 'no Access token' };
	try {
		return await verifyAccessJwt(token, config, teamKeys(config.issuer, fetcher));
	} catch (e) {
		return { ok: false, reason: `verify failed: ${e instanceof Error ? e.message : String(e)}` };
	}
};
