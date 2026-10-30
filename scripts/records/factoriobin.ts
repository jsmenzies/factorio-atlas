/**
 * factoriobin as a site of the record store (store.ts): the stage's factoriobin prints, each record read
 * from the pipeline text the add archived in RAW (`factoriobin/<id>.json`, src/lib/server/pipeline/
 * add-record.ts). Read-only on the stage. factoriobin itself is never listed or polled (it has no
 * listing); posts arrive one at a time through /admin/add or `bun run add`.
 *
 * Listed: live factoriobin sources whose print is their own (`fbin-<id>`). A post that joined an existing
 * print as another source has no print of its own, so nothing to render. The revision is when we first
 * saw it: posts are never edited.
 */
import { fromPipelineText, rawKeyFor } from '#lib/server/pipeline/source-record.js';
import type { StoreAdapter } from './pull';

export interface FactoriobinEnv {
	readonly DB: D1Database;
	readonly RAW: R2Bucket;
}

export const LIVE_FACTORIOBIN_SQL = `SELECT s.site_id, s.first_seen FROM print_sources s JOIN prints p ON p.id = s.print_id
	WHERE s.site = 'factoriobin' AND s.gone_at IS NULL AND s.print_id = 'fbin-' || s.site_id
	ORDER BY s.first_seen, s.site_id`;

export const factoriobinStoreAdapter = (env: FactoriobinEnv): StoreAdapter => ({
	site: 'factoriobin',
	async list() {
		const rows = (await env.DB.prepare(LIVE_FACTORIOBIN_SQL).all<{ site_id: string; first_seen: number }>()).results;
		return rows.map((r) => ({ siteId: r.site_id, rev: String(r.first_seen) }));
	},
	async fetch(siteId) {
		const obj = await env.RAW.get(rawKeyFor('factoriobin', siteId));
		if (!obj) return null;
		const record = fromPipelineText(await obj.text());
		if (!record) throw new Error(`${rawKeyFor('factoriobin', siteId)} is not a factoriobin record`);
		return record;
	}
});
