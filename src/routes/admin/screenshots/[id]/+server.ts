import { error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { pendingOriginal } from '#lib/server/uploads/images.js';
import type { RequestHandler } from './$types';

/**
 * An uploaded screenshot's original from RAW, for the admin queue's preview. Under /admin, so the guard in
 * hooks.server.ts answers 404 without Cloudflare Access and marks every answer `no-store, private`; the
 * image is never public until it is approved and sized into the SCREENSHOTS bucket.
 */
export const GET: RequestHandler = async ({ params }) => {
	const original = await pendingOriginal({ db: env.DB, raw: env.RAW }, params.id);
	if (!original) error(404, 'No such screenshot');
	return new Response(original.body, {
		headers: { 'content-type': original.type, 'content-disposition': 'inline', 'cache-control': 'no-store, private' }
	});
};
