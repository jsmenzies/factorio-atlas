import { error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { controlActions, failedPrints, getRun, intParam, viewerTimeZone } from '#lib/server/admin/pipeline.js';
import { HEARTBEAT_MS, HEARTBEAT_STALE_MS } from '#lib/server/pipeline/runs.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, url, depends, cookies }) => {
	depends('admin:pipeline');
	const now = Date.now();
	const run = await getRun(env.DB, params.runId);
	if (!run) error(404, 'No such run');
	const failed = await failedPrints(env.DB, run, intParam(url, 'failed', 1), now);
	return { run, failed, serverNow: now, timeZone: viewerTimeZone(cookies), staleMs: HEARTBEAT_STALE_MS, heartbeatMs: HEARTBEAT_MS };
};

export const actions: Actions = controlActions;
