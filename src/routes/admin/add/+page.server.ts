import { dev } from '$app/env';
import { env } from 'cloudflare:workers';
import { fail } from '@sveltejs/kit';
import { accessEmail } from '#lib/server/admin/access.js';
import { addInWorker } from '#lib/server/admin/add.js';
import { crossSite } from '#lib/server/admin/sync.js';
import type { Actions } from './$types';

/**
 * Add a print by its link on another site (factoriobin). Deployed, these actions do it in the Worker
 * (src/lib/server/admin/add.ts); under `vite dev` the page runs `bun run add` through the dev plugin
 * instead (scripts/add/dev-plugin.ts), so these are used only deployed or under `bun run preview`.
 */
const linkOf = async (request: Request) => String((await request.formData()).get('link') ?? '').slice(0, 500);

const run = async (request: Request, url: URL, plan: boolean) => {
	if (crossSite(request, url)) return fail(403, { problem: 'Cross-site form posts are refused.' });
	const link = await linkOf(request);
	if (!link.trim()) return fail(400, { problem: 'Paste a factoriobin link.' });
	const view = await addInWorker(env, link, plan);
	if (!plan && view.ok && !view.result.planned && ['new', 'joins'].includes(view.result.status)) {
		console.log(`admin: ${accessEmail(request, dev ? 'dev' : 'admin')} added ${link}: ${view.summary}`);
	}
	return { view };
};

export const actions: Actions = {
	preview: ({ request, url }) => run(request, url, true),
	add: ({ request, url }) => run(request, url, false)
};
