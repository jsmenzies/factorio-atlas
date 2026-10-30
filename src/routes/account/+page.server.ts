import { dev } from '$app/env';
import { fail, redirect } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { clearSessionCookies, sessionToken } from '#lib/server/auth/cookies.js';
import { ACCOUNT_DELETED_MARK } from '#lib/last-sign-in.js';
import { safeReturn } from '#lib/server/auth/oauth.js';
import { SPECS, isProvider } from '#lib/server/auth/providers.js';
import { deleteSession } from '#lib/server/auth/sessions.js';
import { accountProviders, NAME_MAX, NAME_RULE, renameAccount } from '#lib/server/auth/users.js';
import { workerGate } from '#lib/server/uploads/gate.js';
import { deleteAccountStep, listUploads, refreshUploadNames, RENAME_BUDGET_MS } from '#lib/server/uploads/uploads.js';
import type { Actions, PageServerLoad } from './$types';

/** The signed-in account, or off to sign in and back here. */
const required = async (locals: App.Locals) => {
	const account = await locals.account();
	if (!account) redirect(303, '/login?return=/account');
	return account;
};

export const load: PageServerLoad = async ({ locals, url }) => {
	const account = await required(locals);
	const [providers, uploads] = await Promise.all([accountProviders(env.DB, account.id), listUploads(env.DB, account.id)]);
	return {
		account,
		providers: providers.map((p) => (isProvider(p) ? SPECS[p].label : 'Test sign-in')),
		uploads: uploads.map((u) => ({ id: u.print_id, title: u.title, state: u.state, image: u.image_status, createdAt: u.created_at })),
		nameMax: NAME_MAX,
		nameRule: NAME_RULE,
		// Straight from a first sign-in (routes/auth/[provider]/callback).
		welcome: url.searchParams.has('welcome'),
		// Its owner deleted it and some uploads are still to go: the page deletes the rest (?/delete again).
		deleting: account.deleting ? uploads.length : null,
		deleted: url.searchParams.has('deleted'),
		returnTo: safeReturn(url.searchParams.get('return'))
	};
};

export const actions: Actions = {
	rename: async ({ locals, request }) => {
		const account = await required(locals);
		const name = String((await request.formData()).get('name') ?? '');
		if (account.deleting) return fail(409, { problem: 'Your account is being deleted.', name });
		const result = await renameAccount(env.DB, account.id, name);
		if (!result.ok) return fail(400, { problem: result.problem, name });
		// The new name on the account's uploads; what doesn't fit in this request, the next update does.
		const names = await refreshUploadNames({ db: env.DB, raw: env.RAW }, account.id, { budgetMs: RENAME_BUDGET_MS }).catch((e) => {
			console.warn(
				`account: putting the new name on ${account.id}'s uploads failed, left to the sync: ${e instanceof Error ? e.message : e}`
			);
			return { done: 0, left: 1 };
		});
		return { renamed: result.name, namesLeft: names.left };
	},
	signout: async ({ cookies }) => {
		const token = sessionToken(cookies, dev);
		if (token) await deleteSession(env.DB, token);
		clearSessionCookies(cookies, dev);
		redirect(303, '/');
	},
	/**
	 * Its uploads first (decided 2026-10-30: deleting an account deletes its uploads), as many as one request
	 * has time for (deleteAccountStep, shared with the admin's delete), then the account, signed out. With
	 * uploads left, the page posts here again.
	 */
	delete: async ({ locals, request, cookies }) => {
		const account = await required(locals);
		if (!account.deleting && (await request.formData()).get('confirm') !== 'yes')
			return fail(400, { deleteProblem: 'Tick the box to confirm.' });
		const { deleted, left, done } = await deleteAccountStep({ db: env.DB, raw: env.RAW, gate: workerGate(env) }, account.id);
		if (!done) return { deleting: { deleted, left } };
		clearSessionCookies(cookies, dev);
		// The fragment tells the browser to forget the service it signed in with (lib/last-sign-in.ts).
		redirect(303, `/${ACCOUNT_DELETED_MARK}`);
	}
};
