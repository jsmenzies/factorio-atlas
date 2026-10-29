import { dev } from '$app/env';
import { env } from 'cloudflare:workers';
import { fail } from '@sveltejs/kit';
import { isPrintIdLike } from '#lib/reports.js';
import { accessEmail } from '#lib/server/admin/access.js';
import { retryBusy } from '#lib/server/admin/busy.js';
import { applyTakedown, decide, markPurgedByHand, reportQueue } from '#lib/server/reports.js';
import type { TakedownResult } from '#lib/server/takedown.js';
import type { Actions, PageServerLoad } from './$types';

/** Open reports by subject, and the latest decisions (src/lib/server/reports.ts). */
export const load: PageServerLoad = async () => ({
	...(await retryBusy(() => reportQueue(env.DB))),
	purgeOn: Boolean(env.CACHE_PURGE_TOKEN && env.CACHE_ZONE_ID)
});

/** The form's print (checked, so nothing runs for a malformed id), note and screenshot box. */
const fields = async (request: Request) => {
	const form = await request.formData();
	const printId = String(form.get('print') ?? '');
	const note = String(form.get('note') ?? '').trim() || null;
	// The identical copies ticked to go with it (decide checks they really are copies).
	const copies = form.getAll('copy').map(String).filter(isPrintIdLike);
	return { printId: isPrintIdLike(printId) ? printId : null, note, screenshotToo: form.get('screenshot') === 'on', copies };
};

const by = (request: Request) => accessEmail(request, dev ? 'dev' : 'admin');

/** A takedown that threw: the page says why, and the request stays "not finished" (reports.ts records it). */
const takedownFailed = (printId: string, e: unknown) =>
	fail(500, { printId, error: `Takedown stopped: ${e instanceof Error ? e.message : String(e)}. Run it again.` });

export const actions: Actions = {
	approve: async ({ request }) => {
		const { printId, note, screenshotToo, copies } = await fields(request);
		if (!printId) return fail(400, { error: 'No print' });
		try {
			const { decided, takedown } = await decide(env, {
				subjectKind: 'print',
				subjectId: printId,
				approve: true,
				note,
				by: by(request),
				screenshotToo,
				copies
			});
			return { printId, decided, takedown };
		} catch (e) {
			return takedownFailed(printId, e);
		}
	},
	reject: async ({ request }) => {
		const { printId, note } = await fields(request);
		if (!printId) return fail(400, { error: 'No print' });
		const { decided } = await decide(env, { subjectKind: 'print', subjectId: printId, approve: false, note, by: by(request) });
		return { printId, decided, takedown: null as TakedownResult | null };
	},
	/**
	 * Finish an approved takedown that stopped part-way, or purge again what the edge cache kept: it is
	 * idempotent, and purges what earlier runs couldn't. The screenshot goes if the box is ticked, or if an
	 * earlier run already blocked it.
	 */
	retry: async ({ request }) => {
		const { printId, screenshotToo } = await fields(request);
		if (!printId) return fail(400, { error: 'No print' });
		try {
			return { printId, decided: 0, takedown: await applyTakedown(env, printId, screenshotToo) };
		} catch (e) {
			return takedownFailed(printId, e);
		}
	},
	/** The admin purged the listed prefixes and URLs in the dashboard: the requests are applied. */
	purged: async ({ request }) => {
		const { printId } = await fields(request);
		if (!printId) return fail(400, { error: 'No print' });
		const { meta } = await markPurgedByHand(env.DB, printId);
		return { printId, decided: 0, takedown: null as TakedownResult | null, marked: meta.changes ?? 0 };
	}
};
