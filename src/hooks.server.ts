import { dev } from '$app/env';
import type { Handle } from '@sveltejs/kit/hooks';
import { env } from 'cloudflare:workers';
import { adminDenial, adminNotFound, isAdminPath, withAdminHeaders } from '#lib/server/admin/guard.js';

export const handle: Handle = async ({ event, resolve }) => {
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
	return resolve(event);
};
