import { env } from 'cloudflare:workers';
import { controlActions, currentRun, failedPrints, intParam, listRuns, viewerTimeZone } from '#lib/server/admin/pipeline.js';
import { HEARTBEAT_MS, HEARTBEAT_STALE_MS } from '#lib/server/pipeline/runs.js';
import type { Actions, PageServerLoad } from './$types';

/** The current run (newest live one, else the newest), its failed prints, and the run history. */
export const load: PageServerLoad = async ({ url, depends, cookies }) => {
	depends('admin:pipeline');
	const now = Date.now();
	const older = intParam(url, 'older', 0) || undefined;
	const [run, history] = await Promise.all([currentRun(env.DB, now), listRuns(env.DB, older)]);
	const failed = run ? await failedPrints(env.DB, run, intParam(url, 'failed', 1), now) : null;
	return {
		run,
		failed,
		history,
		newer: older !== undefined,
		serverNow: now,
		timeZone: viewerTimeZone(cookies),
		staleMs: HEARTBEAT_STALE_MS,
		heartbeatMs: HEARTBEAT_MS
	};
};

export const actions: Actions = controlActions;
