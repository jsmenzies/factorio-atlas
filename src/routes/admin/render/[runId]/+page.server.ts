import { error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { BUSY_RESULT, orBusy } from '#lib/server/admin/busy.js';
import { liveBase } from '#lib/server/admin/pipeline.js';
import { RENDER_TIMING, renderControlActions, renderRunPage } from '#lib/server/admin/render.js';
import type { Actions, PageServerLoad } from './$types';

/** One render run and the pages it last touched, in one call; `busy` while the local database stays locked (no 500). */
export const load: PageServerLoad = async ({ params, url, depends, cookies }) => {
	const base = { runId: params.runId, ...liveBase({ depends, cookies }, RENDER_TIMING) };
	const page = await orBusy(() => renderRunPage(env.DB, params.runId, url));
	if (page === BUSY_RESULT) return { ...base, busy: true as const };
	if (!page) error(404, 'No such run');
	return { ...base, busy: false as const, ...page };
};

export const actions: Actions = renderControlActions;
