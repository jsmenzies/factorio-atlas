import { env } from 'cloudflare:workers';
import { error, fail } from '@sveltejs/kit';
import type { Site } from '#lib/print-id.js';
import { CONTACT_MAX, DETAILS_MAX, isRemovalReason } from '#lib/reports.js';
import { createRemovalRequest } from '#lib/server/reports.js';
import { goneReason } from '#lib/server/print-pages.js';
import { ownSource, SOURCE_SITES } from '#lib/sources.js';
import { TURNSTILE_FIELD, turnstileSiteKey, verifyTurnstile } from '#lib/server/turnstile.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * "Request removal" for one print: a form anyone can send (Turnstile, REPORT_LIMIT), stored in
 * `reports` for an admin to decide at /admin/reports. Nothing happens to the print until then.
 * noindex, and Disallowed in robots.txt.
 */
export const load: PageServerLoad = async ({ params }) => {
	const [found, sources] = await env.DB.batch([
		env.DB.prepare('SELECT title, author_name FROM prints WHERE id = ?').bind(params.id),
		env.DB.prepare('SELECT DISTINCT site FROM print_sources WHERE print_id = ? AND gone_at IS NULL ORDER BY site').bind(params.id)
	]);
	const print = (found.results as { title: string; author_name: string | null }[])[0];
	if (!print) {
		const gone = await goneReason(params.id);
		if (gone) error(410, gone);
		error(404, 'Print not found');
	}
	// The other sites that keep their own copy (uploads are only here); a print without source rows has its id's.
	const sites = (sources.results as { site: Site }[]).map((r) => r.site);
	const own = ownSource(params.id)?.site;
	const elsewhere = (sites.length ? sites : own ? [own] : []).filter((s) => SOURCE_SITES[s]?.url).map((s) => SOURCE_SITES[s].name);
	return { id: params.id, title: print.title, author: print.author_name, elsewhere, siteKey: turnstileSiteKey(env) };
};

const text = (form: FormData, key: string, max: number) => {
	const v = form.get(key);
	const s = typeof v === 'string' ? v.trim() : '';
	return s ? s.slice(0, max) : null;
};

export const actions: Actions = {
	default: async ({ params, request, url }) => {
		const form = await request.formData();
		const reason = String(form.get('reason') ?? '');
		const details = text(form, 'details', DETAILS_MAX);
		const contact = text(form, 'contact', CONTACT_MAX);
		const values = { reason, details: details ?? '', contact: contact ?? '' };
		if (!isRemovalReason(reason)) return fail(400, { ...values, error: 'Choose a reason.' });
		if (reason === 'other' && !details) return fail(400, { ...values, error: 'Tell us a little about why.' });
		const check = await verifyTurnstile(env, text(form, TURNSTILE_FIELD, 4096), request.headers.get('cf-connecting-ip'), url.hostname);
		if (!check.ok) {
			return fail(check.reason === 'off' ? 503 : 400, {
				...values,
				error:
					check.reason === 'off'
						? 'Removal requests are not available right now.'
						: check.reason === 'unreachable'
							? 'We couldn’t check the form just now. Please try again.'
							: 'Please complete the check above the button, then send again.'
			});
		}
		const stored = await createRemovalRequest(env.DB, { printId: params.id, reason, details, contact, reporterUserId: null });
		if (stored === 'missing') error(404, 'Print not found');
		return { sent: true };
	}
};
