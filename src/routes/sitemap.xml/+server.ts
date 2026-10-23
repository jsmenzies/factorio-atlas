import { dev } from '$app/env';
import { env } from 'cloudflare:workers';
import { pickerEntries } from '#lib/server/picker-items.js';
import { sitemapRows, sitemapXml } from '#lib/server/sitemap.js';
import type { RequestHandler } from './$types';

/**
 * Every print and landing page, for search engines. Built from one D1 read of the whole `prints` table, so the
 * Worker keeps it in the data centre's cache for a day: at most one read per data centre per day,
 * however often it's fetched. (The Cache API needs the custom domain; it does nothing on workers.dev.)
 */
export const GET: RequestHandler = async ({ request, url }) => {
	// Workers' CacheStorage; the DOM lib's type of `caches` hides `default`.
	const cache = dev ? undefined : (caches as CacheStorage & { default: Cache }).default;
	const hit = await cache?.match(request);
	if (hit) return hit;
	const { prints, landings } = await sitemapRows(env.DB);
	// Landing pages only for game items and buildings the search knows (no modded names), as the page itself decides.
	const known = new Set(pickerEntries().map((p) => p.signal));
	const body = sitemapXml(
		url.origin,
		prints,
		landings.filter((l) => known.has(l.value))
	);
	const response = new Response(body, {
		headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=86400' }
	});
	await cache?.put(request, response.clone());
	return response;
};
