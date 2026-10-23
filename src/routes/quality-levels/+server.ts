import { error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { QUALITY_FILTERS, QUALITY_LEVELS } from '#lib/quality.js';
import { retryBusy } from '#lib/server/admin/busy.js';
import { countsOf, parseSearch, qualityLevelsStatement } from '#lib/server/queries.js';
import type { RequestHandler } from './$types';

/**
 * A quality chip's counts, fetched when its choice opens: `?<the search>&filter=uses&value=entity:beacon@epic`
 * gives the matches with that value at any quality and at each level or above, the rest of the search kept.
 * One D1 statement of five FTS counts, rather than five per chip on every search.
 */
export const GET: RequestHandler = async ({ url }) => {
	const search = parseSearch(url);
	const filter = QUALITY_FILTERS.find((f) => f === url.searchParams.get('filter'));
	const value = url.searchParams.get('value') ?? '';
	if (!filter || !search[filter].includes(value)) error(400, 'Not a filter of this search');
	const st = qualityLevelsStatement(search, filter, value);
	const { results } = await retryBusy(() =>
		env.DB.prepare(st.sql)
			.bind(...st.binds)
			.all<Record<string, unknown>>()
	);
	const n = countsOf(results);
	return Response.json(Object.fromEntries(['any', ...QUALITY_LEVELS].map((level, i) => [level, n[i] ?? 0])), {
		// Not for search engines (robots.txt disallows it too).
		headers: { 'cache-control': 'public, max-age=300', 'x-robots-tag': 'noindex' }
	});
};
