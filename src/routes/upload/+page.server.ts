import { fail, redirect } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { TURNSTILE_FIELD, turnstileSiteKey, verifyTurnstile } from '#lib/server/turnstile.js';
import { uploadDeps } from '#lib/server/uploads/env.js';
import { formEcho, readUploadForm } from '#lib/server/uploads/form.js';
import { createUpload, DESCRIPTION_MAX, IMAGE_MAX_BYTES, TITLE_MAX, UPLOADS_PER_DAY } from '#lib/server/uploads/uploads.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Upload a blueprint (lib/server/uploads/uploads.ts): signed in, Turnstile, UPLOAD_LIMIT and the
 * account's daily caps. Never cached (not in CACHED_ROUTES), noindex, and Disallowed in robots.txt.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const account = await locals.account();
	if (!account) redirect(303, '/login?return=/upload');
	return {
		name: account.name,
		siteKey: turnstileSiteKey(env),
		limits: { title: TITLE_MAX, description: DESCRIPTION_MAX, imageMb: IMAGE_MAX_BYTES / 1024 / 1024, perDay: UPLOADS_PER_DAY }
	};
};

export const actions: Actions = {
	default: async ({ locals, request, url }) => {
		const account = await locals.account();
		if (!account) redirect(303, '/login?return=/upload');
		const form = await request.formData();
		const echo = formEcho(form);
		const token = form.get(TURNSTILE_FIELD);
		const check = await verifyTurnstile(
			env,
			typeof token === 'string' ? token : null,
			request.headers.get('cf-connecting-ip'),
			url.hostname
		);
		if (!check.ok) {
			return fail(check.reason === 'off' ? 503 : 400, {
				...echo,
				existing: null,
				problem:
					check.reason === 'off'
						? 'Uploads are not available right now.'
						: check.reason === 'unreachable'
							? 'We couldn’t check the form just now. Please try again.'
							: 'Please complete the check above the button, then send again.'
			});
		}
		const input = await readUploadForm(form, false);
		if ('problem' in input) return fail(400, { ...echo, problem: input.problem, existing: null });
		const result = await createUpload(uploadDeps(url.origin), account, input);
		if (!result.ok) return fail(result.status, { ...echo, problem: result.problem, existing: result.existing ?? null });
		redirect(303, result.state === 'live' ? `/prints/${result.printId}` : `/uploads/${result.printId}?sent=1`);
	}
};
