import { error } from '@sveltejs/kit';
import { SHOT_CONTENT_TYPES, SHOT_KEY } from '#lib/screenshots.js';
import { getShotFile } from '#lib/server/screenshots.js';
import type { RequestHandler } from './$types';

/**
 * Screenshot files from the SCREENSHOTS bucket, for local dev and for stages without a screenshots
 * domain. Image names never change their bytes, so they are immutable; manifests change, so they
 * are kept for minutes.
 */
export const GET: RequestHandler = async ({ params, request }) => {
	if (!SHOT_KEY.test(params.key)) error(404, 'Not a screenshot file');
	const file = await getShotFile(params.key);
	if (!file) error(404, 'No such screenshot file');
	if (file.etag && request.headers.get('if-none-match') === file.etag) return new Response(null, { status: 304 });
	const ext = params.key.slice(params.key.lastIndexOf('.') + 1);
	const headers: Record<string, string> = {
		'content-type': SHOT_CONTENT_TYPES[ext],
		'cache-control': ext === 'json' ? 'public, max-age=300' : 'public, max-age=31536000, immutable'
	};
	if (file.etag) headers.etag = file.etag;
	return new Response(file.body, { headers });
};
