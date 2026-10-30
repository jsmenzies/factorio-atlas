/**
 * Polled sites (scripts/sync/polled.ts: codex) as sites of the record store, filled from the stage like
 * uploads: the prints that are their own print there (`<prefix>-<siteId>`, from that site's live source),
 * each record read from its archive in RAW (`<site>/<siteId>.json`, the pipeline text the ingest wrote).
 * A record that joined another print (the same blueprint already here) is not listed, so the render step
 * never draws it under an id of its own; one gone or taken down has no print row and leaves the store.
 * The revision is the source row's `updated_at`. Read-only on the stage.
 */
import { SITE_PREFIX } from '#lib/print-id.js';
import { fromPipelineText, rawKeyFor } from '#lib/server/pipeline/source-record.js';
import type { StoreAdapter } from './pull';
import type { StoreSite } from './store';

export interface PolledStoreEnv {
	readonly DB: D1Database;
	readonly RAW: R2Bucket;
}

/** The live prints first seen on `site`, with their source row's last change. */
export const OWN_PRINTS_SQL = `SELECT s.site_id, s.updated_at FROM print_sources s JOIN prints p ON p.id = s.print_id
	WHERE s.site = ?1 AND s.gone_at IS NULL AND s.print_id = ?2 || s.site_id
	AND NOT EXISTS (SELECT 1 FROM print_tombstones t WHERE t.print_id = s.print_id)
	ORDER BY s.site_id`;

export const polledStoreAdapter = (env: PolledStoreEnv, site: Exclude<StoreSite, 'upload'>): StoreAdapter => ({
	site,
	async list() {
		const rows = (
			await env.DB.prepare(OWN_PRINTS_SQL).bind(site, `${SITE_PREFIX[site]}-`).all<{ site_id: string; updated_at: number | null }>()
		).results;
		return rows.map((r) => ({ siteId: r.site_id, rev: String(r.updated_at ?? 0) }));
	},
	async fetch(siteId) {
		const obj = await env.RAW.get(rawKeyFor(site, siteId));
		if (!obj) return null;
		const record = fromPipelineText(await obj.text());
		if (!record) throw new Error(`${rawKeyFor(site, siteId)} is not a ${site} record`);
		return record;
	}
});
