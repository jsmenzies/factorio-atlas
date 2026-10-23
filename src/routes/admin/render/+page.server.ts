import { env } from 'cloudflare:workers';
import { BUSY_RESULT, orBusy } from '#lib/server/admin/busy.js';
import { intParam, liveBase } from '#lib/server/admin/pipeline.js';
import { RENDER_TIMING, renderControlActions, renderDashboard } from '#lib/server/admin/render.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * The current render run (newest live one, else the newest), the whole queue, and the run history,
 * read in one call. When the local database stays locked by a run's writes, `busy` instead: the
 * page keeps what it showed (or says it's retrying) and tries again; never a 500.
 */
export const load: PageServerLoad = async ({ url, depends, cookies }) => {
	// The same key as /admin/pipeline, so the shared poll() and syncTimeZone() refresh this page too.
	const base = liveBase({ depends, cookies }, RENDER_TIMING);
	const older = intParam(url, 'older', 0) || undefined;
	const dash = await orBusy(() => renderDashboard(env.DB, url, base.serverNow, older));
	if (dash === BUSY_RESULT) return { ...base, busy: true as const };
	return { ...base, busy: false as const, ...dash, newer: older !== undefined };
};

export const actions: Actions = renderControlActions;
