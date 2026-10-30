import { error, fail } from '@sveltejs/kit';
import { dev } from '$app/env';
import { env } from 'cloudflare:workers';
import { BUSY_RESULT, orBusy } from '#lib/server/admin/busy.js';
import { liveBase } from '#lib/server/admin/pipeline.js';
import { crossSite, SYNC_TIMING, syncOverview } from '#lib/server/admin/sync.js';
import { parseSettings, POLLED_SITES } from '#lib/sync.js';
import { writeMeta } from '#lib/server/sync.js';
import type { Actions, PageServerLoad } from './$types';

/** The update's settings (sync_meta 'settings'), saved here and used by every `bun run sync`. Local only. */
export const load: PageServerLoad = async ({ depends, cookies }) => {
	if (!dev) error(404, 'Not found');
	const base = liveBase({ depends, cookies }, SYNC_TIMING);
	const overview = await orBusy(() => syncOverview(env.DB, base.serverNow));
	if (overview === BUSY_RESULT) return { ...base, busy: true as const };
	return { ...base, busy: false as const, settings: overview.settings, savedAt: overview.settingsSavedAt, scopes: overview.scopes };
};

/** A form number: blank → `blank`, else the number (NaN when it isn't one, which parseSettings rejects). */
const num = (v: FormDataEntryValue | null, blank: number | null) =>
	v === null || String(v).trim() === '' ? blank : Number(String(v).replace(/,/g, ''));

export const actions: Actions = {
	save: async ({ request, url }) => {
		if (!dev) return fail(404, { message: 'Not here.' });
		if (crossSite(request, url)) return fail(403, { message: 'Cross-site form posts are refused.' });
		const form = await request.formData();
		const maxChange = num(form.get('maxChange'), null);
		const { settings, errors } = parseSettings({
			top: num(form.get('top'), null),
			perUpdate: num(form.get('perUpdate'), null),
			workers: num(form.get('workers'), null),
			screenshots: form.get('screenshots') === 'on',
			imgurRecheck: form.get('imgurRecheck'),
			authors: form.get('authors') === 'on',
			authorLimit: num(form.get('authorLimit'), null),
			maxChange: maxChange === null ? null : maxChange / 100,
			polled: Object.fromEntries(
				POLLED_SITES.map(({ site }) => [
					site,
					{ on: form.get(`polled.${site}.on`) === 'on', perUpdate: num(form.get(`polled.${site}.perUpdate`), null) }
				])
			)
		});
		if (errors.length) return fail(400, { errors, message: `Check ${errors.join(', ')}: nothing saved.` });
		const saved = await orBusy(() => writeMeta(env.DB, 'settings', settings));
		if (saved === BUSY_RESULT) return fail(503, { message: 'The local database is busy (a run is writing to it); try again in a moment.' });
		return { ok: true };
	}
};
