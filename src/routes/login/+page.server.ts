import { dev } from '$app/env';
import { redirect } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { safeReturn } from '#lib/server/auth/oauth.js';
import { enabledProviders, SPECS } from '#lib/server/auth/providers.js';
import type { PageServerLoad } from './$types';

/** What went wrong, from the callback's `?error=` (routes/auth/[provider]/callback). */
const ERRORS: Record<string, string> = {
	cancelled: 'Sign-in was cancelled.',
	expired: 'That sign-in took too long or was started in another tab. Please try again.',
	provider: 'The sign-in service didn’t answer as expected. Please try again.',
	banned: 'This account can’t sign in.'
};

export const load: PageServerLoad = async ({ url, locals }) => {
	const returnTo = safeReturn(url.searchParams.get('return'));
	if (await locals.account()) redirect(303, returnTo);
	return {
		providers: enabledProviders(env).map((id) => ({ id, label: SPECS[id].label })),
		returnTo,
		error: ERRORS[url.searchParams.get('error') ?? ''] ?? null,
		devSignIn: dev
	};
};
