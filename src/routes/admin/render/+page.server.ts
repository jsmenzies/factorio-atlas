import { env } from 'cloudflare:workers';
import { BUSY_RESULT, orBusy } from '#lib/server/admin/busy.js';
import { intParam, viewerTimeZone } from '#lib/server/admin/pipeline.js';
import { renderControlActions, renderDashboard } from '#lib/server/admin/render.js';
import { RENDER_HEARTBEAT_MS, RENDER_STALE_MS } from '#lib/server/render-queue.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * The current render run (newest live one, else the newest), the whole queue, and the run history,
 * read in one call. When the local database stays locked by a run's writes, `busy` instead: the
 * page keeps what it showed (or says it's retrying) and tries again; never a 500.
 */
export const load: PageServerLoad = async ({ url, depends, cookies }) => {
	// The same key as /admin/pipeline, so the shared poll() and syncTimeZone() refresh this page too.
	depends('admin:pipeline');
	const now = Date.now();
	const older = intParam(url, 'older', 0) || undefined;
	const base = { serverNow: now, timeZone: viewerTimeZone(cookies), staleMs: RENDER_STALE_MS, heartbeatMs: RENDER_HEARTBEAT_MS };
	const dash = await orBusy(() => renderDashboard(env.DB, url, now, older));
	if (dash === BUSY_RESULT) return { ...base, busy: true as const };
	return { ...base, busy: false as const, ...dash, newer: older !== undefined };
};

export const actions: Actions = renderControlActions;
