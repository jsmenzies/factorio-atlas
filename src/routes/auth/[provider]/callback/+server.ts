import { dev } from '$app/env';
import { error, redirect } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { finishSignIn } from '#lib/server/auth/callback.js';
import type { RequestHandler } from './$types';

/** The provider's redirect back after signing in (lib/server/auth/callback.ts). */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const next = await finishSignIn(params.provider, url, { db: env.DB, vars: env, cookies, dev });
	if (next === null) error(404, 'No such sign-in');
	redirect(303, next);
};
