import { error, fail } from '@sveltejs/kit';
import { dev } from '$app/env';
import { env } from 'cloudflare:workers';
import { BUSY_RESULT, orBusy } from '#lib/server/admin/busy.js';
import { liveBase } from '#lib/server/admin/pipeline.js';
import { crossSite, SYNC_TIMING, syncOverview } from '#lib/server/admin/sync.js';
import { readMeta, stopSync, writeMeta } from '#lib/server/sync.js';
import { parseSettings, type SyncPlan } from '#lib/sync.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * The Update tab (local only, under `vite dev`): run an update (`bun run sync`), with its settings
 * (sync_meta 'settings', saved as they change), each source's plan and what the last update pulled, and
 * the steps. Read in one call (`busy` while a run keeps the local database locked). Deployed there is
 * nothing to update from (the renders, the clone and the sprites are on the machine that renders): 404.
 */
/** This machine's RAM in MB: the memory cap's upper bound (memCapMaxMb). Dev only, so Node's `os` is there; imported lazily. */
const ramMb = async () => (await import('node:os')).totalmem() / 1048576;

export const load: PageServerLoad = async ({ depends, cookies }) => {
	if (!dev) error(404, 'Not found');
	const base = { ...liveBase({ depends, cookies }, SYNC_TIMING), ramMb: await ramMb() };
	const overview = await orBusy(() => syncOverview(env.DB, base.serverNow));
	if (overview === BUSY_RESULT) return { ...base, busy: true as const };
	return { ...base, busy: false as const, ...overview };
};

const BUSY = 'The local database is busy (a run is writing to it); try again in a moment.';

export const actions: Actions = {
	/**
	 * Every setting at once, as JSON in the `settings` field (the page sends the whole set on each change,
	 * so a control that isn't shown keeps its value). Nothing is saved when any field is invalid.
	 */
	save: async ({ request, url }) => {
		if (!dev) return fail(404, { message: 'Not here.' });
		if (crossSite(request, url)) return fail(403, { message: 'Cross-site form posts are refused.' });
		const raw = (await request.formData()).get('settings');
		let input: unknown;
		try {
			input = JSON.parse(typeof raw === 'string' ? raw : '');
		} catch {
			return fail(400, { message: 'No settings sent.' });
		}
		const { settings, errors } = parseSettings(input, { ramMb: await ramMb() });
		if (errors.length) return fail(400, { errors, message: `Not saved: check ${errors.join(', ')}.` });
		const saved = await orBusy(() => writeMeta(env.DB, 'settings', settings));
		if (saved === BUSY_RESULT) return fail(503, { message: BUSY });
		return { ok: true, savedAt: Date.now() };
	},
	stop: async ({ request, url }) => {
		if (!dev) return fail(404, { message: 'Not here.' });
		if (crossSite(request, url)) return fail(403, { message: 'Cross-site form posts are refused.' });
		const form = await request.formData();
		const id = form.get('id');
		if (typeof id !== 'string' || !id) return fail(400, { message: 'Missing update id.' });
		const control = form.get('how') === 'quit' ? 'quit' : 'stop';
		const stopped = await orBusy(() => stopSync(env.DB, id, control));
		if (stopped === BUSY_RESULT) return fail(503, { message: BUSY });
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
		if (done === BUSY_RESULT) return fail(503, { message: BUSY });
		if (!done) return fail(409, { message: "The last check didn't hold that update back: check again." });
		return { ok: true };
	}
};
