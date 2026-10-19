/**
 * The /admin guard, run from hooks.server.ts for every request, so it covers pages, their
 * `__data.json`, form actions and JSON endpoints alike.
 *
 * - Local dev (`vite dev`): allowed.
 * - Deployed: needs a valid Cloudflare Access JWT for ACCESS_TEAM_DOMAIN / ACCESS_AUD. When those
 *   vars are unset, or the token is missing or invalid, /admin is a plain 404 (fail closed, and
 *   the public site doesn't advertise that an admin area exists). The reason goes to the log.
 */
import { accessConfig, verifyAccessRequest } from './access.js';

/**
 * True for /admin and anything under it. Checks the decoded, lower-cased path too, since the
 * router matches decoded paths (`/%61dmin` reaches the admin routes) and Access paths ignore case.
 * An undecodable path counts as admin (fail closed).
 */
export const isAdminPath = (pathname: string, routeId?: string | null) => {
	if (routeId === '/admin' || routeId?.startsWith('/admin/')) return true;
	let path: string;
	try {
		path = decodeURIComponent(pathname);
	} catch {
		return true;
	}
	path = path.toLowerCase().replace(/\/{2,}/g, '/');
	return path === '/admin' || path.startsWith('/admin/');
};

export interface AdminVars {
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
}

/** Null when the request may proceed, else the (logged) reason it may not. */
export const adminDenial = async (request: Request, vars: AdminVars, dev: boolean, fetcher: typeof fetch = fetch) => {
	if (dev) return null;
	const config = accessConfig(vars);
	if (!config) return 'ACCESS_TEAM_DOMAIN or ACCESS_AUD is not set';
	const result = await verifyAccessRequest(request, config, fetcher);
	return result.ok ? null : result.reason;
};

/** Headers for every /admin response: never cached anywhere, never indexed. */
export const ADMIN_HEADERS: Record<string, string> = {
	'cache-control': 'no-store, private',
	'x-robots-tag': 'noindex, nofollow'
};

export const withAdminHeaders = (response: Response) => {
	// Responses from resolve() can have immutable headers (e.g. redirects); copy when needed.
	let out = response;
	try {
		for (const [k, v] of Object.entries(ADMIN_HEADERS)) out.headers.set(k, v);
	} catch {
		out = new Response(response.body, response);
		for (const [k, v] of Object.entries(ADMIN_HEADERS)) out.headers.set(k, v);
	}
	return out;
};

export const adminNotFound = () => withAdminHeaders(new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } }));
