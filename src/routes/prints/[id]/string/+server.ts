import { error } from '@sveltejs/kit';
import { goneReason, loadPageString, loadString } from '#lib/server/print-pages.js';
import type { RequestHandler } from './$types';

/**
 * The exchange string, served from R2 so pages don't carry 100s of KB. `?page=3/1` returns
 * just that blueprint page as its own importable string, made at ingest.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const path = url.searchParams.get('page');
	// Not for search engines (robots.txt disallows it too).
	const headers = { 'cache-control': 'public, max-age=300', 'x-robots-tag': 'noindex' };
	// A print taken down on request, or an upload its owner deleted, answers 410, whatever R2 still holds
	// (print-pages.ts, loadPrintDoc).
	const [body, gone] = await Promise.all([
		path === null || path === '' ? loadString(params.id) : loadPageString(params.id, path),
		goneReason(params.id)
	]);
	if (gone) error(410, gone);
	if (body === null) error(404, path ? 'No such page' : 'Not in raw store');
	return new Response(body, { headers });
};
