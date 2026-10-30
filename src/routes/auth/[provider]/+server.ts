import { dev } from '$app/env';
import { error, redirect } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { setFlowCookie } from '#lib/server/auth/cookies.js';
import { authorizeUrl, newFlow } from '#lib/server/auth/oauth.js';
import { isProvider, providerClient } from '#lib/server/auth/providers.js';
import type { RequestHandler } from './$types';

/** Starts signing in: off to the provider, with `?return=<path>` kept for afterwards (lib/server/auth/oauth.ts). */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const client = isProvider(params.provider) ? providerClient(env, params.provider) : null;
	if (!isProvider(params.provider) || !client) error(404, 'No such sign-in');
	const flow = newFlow(params.provider, url.searchParams.get('return'));
	setFlowCookie(cookies, flow, dev);
	redirect(302, await authorizeUrl(flow, client, url.origin));
};
