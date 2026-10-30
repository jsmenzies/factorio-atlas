import { error, fail, redirect } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { workerGate } from '#lib/server/uploads/gate.js';
import { uploadDeps } from '#lib/server/uploads/env.js';
import { formEcho, readUploadForm } from '#lib/server/uploads/form.js';
import { imageCopied } from '#lib/server/uploads/images.js';
import {
	deleteUpload,
	DESCRIPTION_MAX,
	editUpload,
	IMAGE_MAX_BYTES,
	ownUpload,
	readRecord,
	TITLE_MAX
} from '#lib/server/uploads/uploads.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * One of the signed-in account's uploads: where it stands (processing, live, refused), and its edit
 * and delete forms. Someone else's upload, or none, is a 404. Never cached, noindex, Disallowed.
 */
const required = async (locals: App.Locals, id: string) => {
	const account = await locals.account();
	if (!account) redirect(303, `/login?return=${encodeURIComponent(`/uploads/${id}`)}`);
	return account;
};

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const account = await required(locals, params.id);
	const row = await ownUpload(env.DB, account.id, params.id);
	const record = row ? await readRecord(env.RAW, params.id) : null;
	if (!row || !record) error(404, 'No such upload');
	return {
		upload: {
			id: row.print_id,
			state: row.state,
			tooBig: row.too_big,
			refusedReason: row.refused_reason,
			refusedPrintId: row.refused_print_id,
			failure: row.failure,
			image: row.image_status,
			// Sized and on the site (the screenshots step's `screenshots` row), or still waiting for the next update.
			imageShown: row.image_id !== null && row.image_status === 'approved' && (await imageCopied(env.DB, row.image_id)),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			live: row.live_at !== null
		},
		values: { title: record.title ?? '', description: record.description ?? '' },
		limits: { title: TITLE_MAX, description: DESCRIPTION_MAX, imageMb: IMAGE_MAX_BYTES / 1024 / 1024 },
		sent: url.searchParams.has('sent')
	};
};

export const actions: Actions = {
	save: async ({ locals, params, request, url }) => {
		const account = await required(locals, params.id);
		const form = await request.formData();
		const echo = formEcho(form);
		const input = await readUploadForm(form, true);
		if ('problem' in input) return fail(400, { ...echo, problem: input.problem, existing: null });
		const result = await editUpload(uploadDeps(url.origin), account, params.id, input);
		if (!result.ok) {
			if (result.status === 404) error(404, 'No such upload');
			return fail(result.status, { ...echo, problem: result.problem, existing: result.existing ?? null });
		}
		return { saved: result.state };
	},
	delete: async ({ locals, params, request }) => {
		const account = await required(locals, params.id);
		if ((await request.formData()).get('confirm') !== 'yes') return fail(400, { deleteProblem: 'Tick the box to confirm.' });
		if (!(await deleteUpload({ db: env.DB, raw: env.RAW, gate: workerGate(env) }, account.id, params.id))) error(404, 'No such upload');
		redirect(303, '/account?deleted=1');
	}
};
