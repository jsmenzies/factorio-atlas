import { dev } from '$app/env';
import { error, redirect } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { sessionToken, setSessionCookies } from '#lib/server/auth/cookies.js';
import { safeReturn } from '#lib/server/auth/oauth.js';
import { createSession } from '#lib/server/auth/sessions.js';
import { signInAccount } from '#lib/server/auth/users.js';
import type { RequestHandler } from './$types';

/**
 * vite dev only: signs in as a local test account without a provider (`?as=<name>`, default
 * "Tester"), so uploads can be tried with no OAuth app. A 404 in every build (`dev` is false there).
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	if (!dev) error(404, 'Not found');
	const as = url.searchParams.get('as') || 'Tester';
	const result = await signInAccount(env.DB, 'dev', { subject: as.toLowerCase(), name: as });
	if (!result.ok) error(403, 'Banned');
	const session = await createSession(env.DB, result.account.id, Date.now(), sessionToken(cookies, dev));
	setSessionCookies(cookies, session.token, session.expiresAt, dev);
	redirect(303, safeReturn(url.searchParams.get('return')));
};
