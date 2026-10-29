/**
 * Cloudflare Turnstile, for forms anyone can send (removal requests; uploads later). The page renders
 * the widget with TURNSTILE_SITE_KEY, which puts a token in the form's `cf-turnstile-response` field;
 * the action checks it here with Siteverify. Locally wrangler.jsonc has Cloudflare's always-passing
 * test key, paired with its test secret; a deployed stage gets real keys from alchemy.run.ts, or an
 * empty site key, which turns the forms off.
 */

export const TURNSTILE_FIELD = 'cf-turnstile-response';
const TEST_SITE_KEY = '1x00000000000000000000AA';
const TEST_SECRET = '1x0000000000000000000000000000000AA';
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileKeys {
	readonly TURNSTILE_SITE_KEY: string;
	readonly TURNSTILE_SECRET_KEY?: string;
}

/** The site key to render the widget with, or null when the forms are off on this stage. */
export const turnstileSiteKey = (env: TurnstileKeys) => env.TURNSTILE_SITE_KEY || null;

const secretFor = (env: TurnstileKeys) => env.TURNSTILE_SECRET_KEY || (env.TURNSTILE_SITE_KEY === TEST_SITE_KEY ? TEST_SECRET : null);

export type TurnstileResult = { ok: true } | { ok: false; reason: 'off' | 'missing' | 'failed' | 'unreachable'; codes?: string[] };

/**
 * Check a form's token with Siteverify. `ip` (cf-connecting-ip) is optional, as Cloudflare allows.
 * `hostname`, the site's own (the request URL's), makes a token solved on another site fail; the test
 * keys answer with a placeholder hostname, so it isn't checked with them.
 */
export async function verifyTurnstile(
	env: TurnstileKeys,
	token: string | null,
	ip: string | null,
	hostname?: string
): Promise<TurnstileResult> {
	const secret = secretFor(env);
	if (!turnstileSiteKey(env) || !secret) return { ok: false, reason: 'off' };
	if (!token) return { ok: false, reason: 'missing' };
	const body = new FormData();
	body.set('secret', secret);
	body.set('response', token);
	if (ip) body.set('remoteip', ip);
	try {
		const res = await fetch(SITEVERIFY, { method: 'POST', body });
		const out = (await res.json()) as { success?: boolean; hostname?: string; 'error-codes'?: string[] };
		if (!out.success) return { ok: false, reason: 'failed', codes: out['error-codes'] ?? [] };
		if (hostname && secret !== TEST_SECRET && out.hostname !== hostname)
			return { ok: false, reason: 'failed', codes: ['hostname-mismatch'] };
		return { ok: true };
	} catch {
		return { ok: false, reason: 'unreachable' };
	}
}
