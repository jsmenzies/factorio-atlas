import { env } from 'cloudflare:workers';
import { error, fail, redirect } from '@sveltejs/kit';
import { accountDetail, adminDeleteAccount, endSessions } from '#lib/server/admin/accounts.js';
import { retryBusy } from '#lib/server/admin/busy.js';
import { crossSite } from '#lib/server/admin/sync.js';
import { workerGate } from '#lib/server/uploads/gate.js';
import type { Actions, PageServerLoad } from './$types';

/** One account: the list's facts and its uploads (lib/server/admin/accounts.ts). */
export const load: PageServerLoad = async ({ params }) => {
	const detail = await retryBusy(() => accountDetail(env.DB, params.id));
	if (!detail) error(404, 'No such account');
	return {
		account: detail.account,
		uploads: detail.uploads.map((u) => ({
			id: u.print_id,
			title: u.title,
			state: u.state,
			refusedReason: u.refused_reason,
			image: u.image_status,
			createdAt: u.created_at
		}))
	};
};

// SvelteKit checks a form post's origin only in builds; under vite dev these check it themselves.
const refused = () => fail(403, { problem: 'Cross-site form posts are refused.' });

export const actions: Actions = {
	/** Ends every session: the account is signed out on every browser (it can sign in again). */
	signout: async ({ request, url, params }) => {
		if (crossSite(request, url)) return refused();
		const ended = await endSessions(env.DB, params.id);
		console.log(`admin: signed account ${params.id} out everywhere (${ended} sessions)`);
		return { ended };
	},
	/**
	 * Deletes the account the way its owner would (uploads.ts deleteAccountStep): its uploads, as many as
	 * one request has time for, then the account. With uploads left, the page posts here again.
	 */
	delete: async ({ request, url, params }) => {
		if (crossSite(request, url)) return refused();
		const typed = (await request.formData()).get('name');
		const result = await adminDeleteAccount(
			{ db: env.DB, raw: env.RAW, gate: workerGate(env) },
			params.id,
			typed === null ? null : String(typed)
		);
		if (!result.ok) return fail(result.status, { problem: result.problem });
		if (!result.done) return { deleting: { deleted: result.deleted, left: result.left } };
		console.log(`admin: deleted account ${params.id}`);
		redirect(303, `/admin/accounts?deleted=${encodeURIComponent(result.name)}`);
	}
	// Suspend and ban come later (users.banned_at, ban_reason in migration 0023): their actions go here.
};
