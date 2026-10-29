import { fail, redirect } from '@sveltejs/kit';
import { dev } from '$app/env';
import { env } from 'cloudflare:workers';
import { BUSY_RESULT, orBusy } from '#lib/server/admin/busy.js';
import { liveBase } from '#lib/server/admin/pipeline.js';
import { crossSite, SYNC_TIMING, syncOverview } from '#lib/server/admin/sync.js';
import { readMeta, stopSync, writeMeta } from '#lib/server/sync.js';
import type { SyncPlan } from '#lib/sync.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Under `vite dev`, the Overview: updates (`bun run sync`), what the next one would do, and the
 * figures, read in one call (`busy` while a run keeps the local database locked). Deployed, there is
 * nothing to update from (the renders, the clone and the sprites are on the machine that renders),
 * so /admin is the pipeline page, as before.
 */
export const load: PageServerLoad = async ({ depends, cookies }) => {
	if (!dev) redirect(307, '/admin/pipeline');
	const base = liveBase({ depends, cookies }, SYNC_TIMING);
	const overview = await orBusy(() => syncOverview(env.DB, base.serverNow));
	if (overview === BUSY_RESULT) return { ...base, busy: true as const };
	return { ...base, busy: false as const, ...overview };
};

export const actions: Actions = {
	stop: async ({ request, url }) => {
		if (!dev) return fail(404, { message: 'Not here.' });
		if (crossSite(request, url)) return fail(403, { message: 'Cross-site form posts are refused.' });
		const form = await request.formData();
		const id = form.get('id');
		if (typeof id !== 'string' || !id) return fail(400, { message: 'Missing update id.' });
		const control = form.get('how') === 'quit' ? 'quit' : 'stop';
		const stopped = await orBusy(() => stopSync(env.DB, id, control));
		if (stopped === BUSY_RESULT)
			return fail(503, { message: 'The local database is busy (a run is writing to it); try again in a moment.' });
		if (!stopped) return fail(409, { message: 'This update has already ended.' });
		return { ok: true };
	},
	/** Fetch a held-back source update anyway: only the one the last check held back, by its id. */
	accept: async ({ request, url }) => {
		if (!dev) return fail(404, { message: 'Not here.' });
		if (crossSite(request, url)) return fail(403, { message: 'Cross-site form posts are refused.' });
		const form = await request.formData();
		const site = form.get('site');
		const id = form.get('id');
		const done = await orBusy(async () => {
			const held = (await readMeta<SyncPlan>(env.DB, 'plan'))?.value.sources.find((p) => p.site === site && p.blocked);
			if (!held || held.to.id !== id) return false;
			const accepted = (await readMeta<Record<string, string>>(env.DB, 'accept'))?.value ?? {};
			await writeMeta(env.DB, 'accept', { ...accepted, [held.site]: held.to.id });
			return true;
		});
		if (done === BUSY_RESULT) return fail(503, { message: 'The local database is busy (a run is writing to it); try again in a moment.' });
		if (!done) return fail(409, { message: "The last check didn't hold that update back: check again." });
		return { ok: true };
	}
};
