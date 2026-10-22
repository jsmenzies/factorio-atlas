import { error } from '@sveltejs/kit';
import { getRenderFile } from '#lib/server/renders.js';
import { RENDER_FILE, renderCacheControl } from '#lib/viewer/game-render.js';
import type { RequestHandler } from './$types';

/**
 * Game render files: `/prints/<id>/render/<page>.<stamp>.avif|<page>.json|<page>.page.json`, tiles
 * at `t/<hash>.avif`, and `index.json`. Every image is named by its content (tiles by pixel hash,
 * overviews by render stamp), so it is cached for good; the JSON files keep their names and are
 * cached briefly, with the same rules the uploader sets on the bucket's objects.
 */
export const GET: RequestHandler = async ({ params, request }) => {
	if (!RENDER_FILE.test(params.file)) error(404, 'Not a render file');
	const file = await getRenderFile(`${params.id}/${params.file}`);
	if (!file) error(404, 'No render');
	if (file.etag && request.headers.get('if-none-match') === file.etag) return new Response(null, { status: 304 });
	const headers: Record<string, string> = {
		'content-type': params.file.endsWith('.json') ? 'application/json' : 'image/avif',
		'cache-control': renderCacheControl(params.file)
	};
	if (file.etag) headers.etag = file.etag;
	return new Response(file.body, { headers });
};
