import { dev, version } from '$app/env';
import type { Handle } from '@sveltejs/kit/hooks';
import { env, waitUntil } from 'cloudflare:workers';
import { adminDenial, adminNotFound, isAdminPath, withAdminHeaders } from '#lib/server/admin/guard.js';
import { clearHintCookie, hasHintCookie, sessionToken } from '#lib/server/auth/cookies.js';
import { accountReader } from '#lib/server/auth/locals.js';
import { cachedPage, cacheTtl } from '#lib/server/page-cache.js';
import { rateLimited } from '#lib/server/rate-limit.js';
import { withSecurityHeaders } from '#lib/server/security-headers.js';

/** Every response the Worker sends carries the security headers (lib/server/security-headers.ts). */
export const handle: Handle = async (input) => withSecurityHeaders(await guarded(input));

const guarded: Handle = async ({ event, resolve }) => {
	const ttl = cacheTtl(event.request.method, event.route.id);
	// Cached routes can't read the session (lib/server/auth/locals.ts); asking throws, under vite dev too.
	event.locals.account = accountReader(env.DB, event.cookies, dev, ttl !== null);
	// A hint cookie without a session (it expired, or was deleted) goes, so the header says "Sign in"
	// again. Never on a cached route: a Set-Cookie would keep its page out of the cache.
	if (ttl === null && hasHintCookie(event.cookies) && !sessionToken(event.cookies, dev)) clearHintCookie(event.cookies, dev);
	// /admin is private (Cloudflare Access, checked again here) and never cached. This runs before
	// anything else, so any edge caching must stay below it.
	if (isAdminPath(event.url.pathname, event.route.id)) {
		const denied = await adminDenial(event.request, env, dev);
		if (denied) {
			console.warn(`admin: denied ${event.request.method} ${event.url.pathname}: ${denied}`);
			return adminNotFound();
		}
		return withAdminHeaders(await resolve(event));
	}
	// Limits and the page cache are off under vite dev, so local tools and screenshots never hit
	// them (and edits show at once); `bun run preview` has both.
	if (!dev) {
		const limited = await rateLimited(event.request, event.route.id, event.url, env);
		if (limited) return limited;
		// Search and print pages come from the location's cache when they can (lib/server/page-cache.ts).
		if (ttl !== null) {
			// Workers' CacheStorage; the DOM lib's type of `caches` hides `default`.
			const cache = (caches as CacheStorage & { default: Cache }).default;
			return cachedPage(event.request, ttl, () => resolve(event), { cache, db: env.DB, build: version, waitUntil });
		}
	}
	return resolve(event);
};
