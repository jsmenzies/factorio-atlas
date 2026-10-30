import { redirect } from '@sveltejs/kit';
import { dev } from '$app/env';
import { env } from 'cloudflare:workers';
import { BUSY_RESULT, orBusy } from '#lib/server/admin/busy.js';
import { liveBase } from '#lib/server/admin/pipeline.js';
import { SYNC_TIMING, syncOverview } from '#lib/server/admin/sync.js';
import type { PageServerLoad } from './$types';

/**
 * Under `vite dev`, the Overview: read-only, what the site has (the figures the last update or "Count
 * again" read from the stage, sync_meta 'figures'), what needs looking at, render coverage and the
 * updates, read in one call (`busy` while a run keeps the local database locked). Updates are run from
 * /admin/update. Deployed, there is nothing to update from (the renders, the clone and the sprites are
 * on the machine that renders), so /admin is the pipeline page, as before.
 */
export const load: PageServerLoad = async ({ depends, cookies }) => {
	if (!dev) redirect(307, '/admin/pipeline');
	const base = liveBase({ depends, cookies }, SYNC_TIMING);
	const overview = await orBusy(() => syncOverview(env.DB, base.serverNow));
	if (overview === BUSY_RESULT) return { ...base, busy: true as const };
	return { ...base, busy: false as const, ...overview };
};
