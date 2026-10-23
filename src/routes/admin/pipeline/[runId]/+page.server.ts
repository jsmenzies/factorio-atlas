import { error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { controlActions, failedPrints, getRun, intParam, liveBase, PIPELINE_TIMING } from '#lib/server/admin/pipeline.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, url, depends, cookies }) => {
	const base = liveBase({ depends, cookies }, PIPELINE_TIMING);
	const run = await getRun(env.DB, params.runId);
	if (!run) error(404, 'No such run');
	const failed = await failedPrints(env.DB, run, intParam(url, 'failed', 1), base.serverNow);
	return { ...base, run, failed };
};

export const actions: Actions = controlActions;
