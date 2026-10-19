import { error } from '@sveltejs/kit';
import { getRenderFile } from '#lib/server/renders.js';
import { RENDER_FILE } from '#lib/viewer/game-render.js';
import type { RequestHandler } from './$types';

/**
 * Game render images and sidecars: `/prints/<id>/render/<page>.webp|.json`, tiles under
 * `<page>.tiles/<ppt>/<col>-<row>.webp`, and `index.json`. Image URLs carry `?v=<stamp>`
 * from the sidecar, so they can be cached for good; a re-render gets a new stamp.
 */
export const GET: RequestHandler = async ({ params, url, request }) => {
	if (!RENDER_FILE.test(params.file)) error(404, 'Not a render file');
	const file = await getRenderFile(`${params.id}/${params.file}`);
	if (!file) error(404, 'No render');
	if (file.etag && request.headers.get('if-none-match') === file.etag) return new Response(null, { status: 304 });
	const json = params.file.endsWith('.json');
	const headers: Record<string, string> = {
		'content-type': json ? 'application/json' : 'image/webp',
		'cache-control': json
			? 'public, max-age=300'
			: url.searchParams.has('v')
				? 'public, max-age=31536000, immutable'
				: 'public, max-age=3600'
	};
	if (file.etag) headers.etag = file.etag;
	return new Response(file.body, { headers });
};
