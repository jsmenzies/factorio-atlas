import { dev } from '$app/env';
import { env } from 'cloudflare:workers';
import { fail } from '@sveltejs/kit';
import { accessEmail } from '#lib/server/admin/access.js';
import { retryBusy } from '#lib/server/admin/busy.js';
import { workerGate } from '#lib/server/uploads/gate.js';
import { approveImage, originalSize, pendingImages, rejectImage } from '#lib/server/uploads/images.js';
import type { Actions, PageServerLoad } from './$types';

/** Upload screenshots waiting for a decision (src/lib/server/uploads/images.ts), each with its size from its header. */
export const load: PageServerLoad = async () => {
	const { images, total } = await retryBusy(() => pendingImages(env.DB));
	const sizes = await Promise.all(images.map((i) => originalSize(env.RAW, i.id, i.ext).catch(() => null)));
	return { images: images.map((i, n) => ({ ...i, size: sizes[n] })), total };
};

const imageOf = async (request: Request) => {
	const id = String((await request.formData()).get('image') ?? '');
	return /^[0-9a-f]{16}$/.test(id) ? id : null;
};

const by = (request: Request) => accessEmail(request, dev ? 'dev' : 'admin');

export const actions: Actions = {
	approve: async ({ request }) => {
		const id = await imageOf(request);
		if (!id) return fail(400, { id, problem: 'No screenshot' });
		const r = await approveImage({ db: env.DB, raw: env.RAW, gate: workerGate(env) }, id);
		if (!r.ok) return fail(409, { id, problem: r.problem });
		console.log(`admin: ${by(request)} approved upload screenshot ${id} (${r.uploads} uploads, ${r.shown} re-ingested)`);
		return { id, decided: r };
	},
	reject: async ({ request }) => {
		const id = await imageOf(request);
		if (!id) return fail(400, { id, problem: 'No screenshot' });
		const r = await rejectImage({ db: env.DB, raw: env.RAW }, id);
		if (!r.ok) return fail(409, { id, problem: r.problem });
		console.log(`admin: ${by(request)} rejected upload screenshot ${id} (${r.uploads} uploads)`);
		return { id, decided: r };
	}
};
