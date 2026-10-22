import { error } from '@sveltejs/kit';
import { CONTENT_TYPES, getSpriteFile, SPRITE_KEY } from '#lib/server/sprites.js';
import type { RequestHandler } from './$types';

/**
 * Sprite files (icons) from the SPRITES bucket, for local dev and for stages without a sprites
 * domain. Keys are content-hashed, so responses are immutable.
 */
export const GET: RequestHandler = async ({ params, request }) => {
	if (!SPRITE_KEY.test(params.key)) error(404, 'Not a sprite file');
	const file = await getSpriteFile(params.key);
	if (!file) error(404, 'No such sprite file');
	if (file.etag && request.headers.get('if-none-match') === file.etag) return new Response(null, { status: 304 });
	const headers: Record<string, string> = {
		'content-type': CONTENT_TYPES[params.key.slice(params.key.lastIndexOf('.') + 1)],
		'cache-control': 'public, max-age=31536000, immutable'
	};
	if (file.etag) headers.etag = file.etag;
	return new Response(file.body, { headers });
};
