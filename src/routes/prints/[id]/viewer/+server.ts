import { error } from '@sveltejs/kit';
import { loadViewerPage } from '#lib/server/print-pages.js';
import type { RequestHandler } from './$types';

/**
 * One page for the print page's inline viewer, fetched after the page itself has loaded so
 * a 12,000-entity page doesn't hold up the rest. `?page=<book path>`.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const found = await loadViewerPage(params.id, url.searchParams.get('page'));
	if (!found) error(404, 'No viewer files');
	return Response.json({ page: found.page, render: found.render }, { headers: { 'cache-control': 'public, max-age=300' } });
};
