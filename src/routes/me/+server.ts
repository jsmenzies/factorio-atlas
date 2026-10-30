import { json } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { ownUpload } from '#lib/server/uploads/uploads.js';
import type { RequestHandler } from './$types';

/**
 * Who is signed in, for the header (AccountLink): `{ account: { id, name } | null }`. Pages are cached
 * for everyone (lib/server/page-cache.ts), so they never say; the browser asks here once it knows a
 * session cookie may exist. With `?print=<id>` it also says whether that print is the account's own
 * upload (`owns`), for the print page's Edit link (OwnerLinks).
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	const account = await locals.account();
	const print = url.searchParams.get('print');
	const owns = account !== null && print !== null && (await ownUpload(env.DB, account.id, print)) !== null;
	return json(
		{ account, ...(print !== null ? { owns } : {}) },
		{ headers: { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' } }
	);
};
