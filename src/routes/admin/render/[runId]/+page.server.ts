import { error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { BUSY_RESULT, orBusy } from '#lib/server/admin/busy.js';
import { viewerTimeZone } from '#lib/server/admin/pipeline.js';
import { renderControlActions, renderRunPage } from '#lib/server/admin/render.js';
import { RENDER_HEARTBEAT_MS, RENDER_STALE_MS } from '#lib/server/render-queue.js';
import type { Actions, PageServerLoad } from './$types';

/** One render run and the pages it last touched, in one call; `busy` while the local database stays locked (no 500). */
export const load: PageServerLoad = async ({ params, url, depends, cookies }) => {
	depends('admin:pipeline');
	const now = Date.now();
	const base = {
		runId: params.runId,
		serverNow: now,
		timeZone: viewerTimeZone(cookies),
		staleMs: RENDER_STALE_MS,
		heartbeatMs: RENDER_HEARTBEAT_MS
	};
	const page = await orBusy(() => renderRunPage(env.DB, params.runId, url));
	if (page === BUSY_RESULT) return { ...base, busy: true as const };
	if (!page) error(404, 'No such run');
	return { ...base, busy: false as const, ...page };
};

export const actions: Actions = renderControlActions;
