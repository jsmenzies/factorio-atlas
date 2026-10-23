import { error } from '@sveltejs/kit';
import { loadPageString, loadString } from '#lib/server/print-pages.js';
import type { RequestHandler } from './$types';

/**
 * The exchange string, served from R2 so pages don't carry 100s of KB. `?page=3/1` returns
 * just that blueprint page as its own importable string, made at ingest.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const path = url.searchParams.get('page');
	// Not for search engines (robots.txt disallows it too).
	const headers = { 'cache-control': 'public, max-age=300', 'x-robots-tag': 'noindex' };
	if (path === null || path === '') {
		const body = await loadString(params.id);
		if (body === null) error(404, 'Not in raw store');
		return new Response(body, { headers });
	}
	const body = await loadPageString(params.id, path);
	if (body === null) error(404, 'No such page');
	return new Response(body, { headers });
};
