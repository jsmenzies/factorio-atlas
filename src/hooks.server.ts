import { dev } from '$app/env';
import type { Handle } from '@sveltejs/kit/hooks';
import { env } from 'cloudflare:workers';
import { adminDenial, adminNotFound, isAdminPath, withAdminHeaders } from '#lib/server/admin/guard.js';
import { rateLimited } from '#lib/server/rate-limit.js';
import { withSecurityHeaders } from '#lib/server/security-headers.js';

/** Every response the Worker sends carries the security headers (lib/server/security-headers.ts). */
export const handle: Handle = async (input) => withSecurityHeaders(await guarded(input));

const guarded: Handle = async ({ event, resolve }) => {
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
	// Off under vite dev, so local tools and screenshots never hit it; `bun run preview` has it.
	if (!dev) {
		const limited = await rateLimited(event.request, event.route.id, event.url, env);
		if (limited) return limited;
	}
	return resolve(event);
};
