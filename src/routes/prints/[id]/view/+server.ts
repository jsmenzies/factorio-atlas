import { env } from 'cloudflare:workers';
import { recordView } from '#lib/server/views.js';
import type { RequestHandler } from './$types';

/**
 * The print page's view request (a keepalive `fetch`): one Analytics Engine data point per view,
 * holding only the print id (lib/server/views.ts). Always 204, so it tells a caller nothing.
 */
export const POST: RequestHandler = ({ params, request }) => {
	recordView(env.VIEWS, params.id, request.headers.get('user-agent'));
	return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
};
