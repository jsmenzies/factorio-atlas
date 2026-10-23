import { robotsTxt } from '#lib/server/sitemap.js';
import type { RequestHandler } from './$types';

/** A route, not a static file, so the `Sitemap:` line can be absolute without naming the domain. */
export const GET: RequestHandler = ({ url }) =>
	new Response(robotsTxt(url.origin), {
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' }
	});
