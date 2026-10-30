/**
 * Uploads as a site of the record store (store.ts): the stage's live uploads, each record read from its
 * only copy, the pipeline text in RAW (`upload/<siteId>.json`, src/lib/server/uploads/uploads.ts).
 * Read-only on the stage.
 *
 * The revision is the upload's `updated_at` (every owner edit moves it) and its shown name (a rename
 * rewrites the RAW record's author without an edit). An upload that is processing, refused or failed is
 * not on the site, so not listed; one deleted or taken down has no row (its purge deletes it), or a
 * tombstone, and leaves the store at the next pull.
 */
import { fromPipelineText } from '#lib/server/pipeline/source-record.js';
import { recordKey, siteIdOf } from '#lib/server/uploads/uploads.js';
import type { StoreAdapter } from './pull';

export interface UploadsEnv {
	readonly DB: D1Database;
	readonly RAW: R2Bucket;
}

/** The query `list` runs: live uploads with no tombstone. Uses uploads_state. */
export const LIVE_UPLOADS_SQL = `SELECT u.print_id, u.updated_at, u.shown_name FROM uploads u
	WHERE u.state = 'live' AND NOT EXISTS (SELECT 1 FROM print_tombstones t WHERE t.print_id = u.print_id)
	ORDER BY u.updated_at, u.print_id`;

export const uploadRev = (row: { updated_at: number; shown_name: string }) => `${row.updated_at}:${row.shown_name}`;

export const uploadsStoreAdapter = (env: UploadsEnv): StoreAdapter => ({
	site: 'upload',
	async list() {
		const rows = (await env.DB.prepare(LIVE_UPLOADS_SQL).all<{ print_id: string; updated_at: number; shown_name: string }>()).results;
		return rows.map((r) => ({ siteId: siteIdOf(r.print_id), rev: uploadRev(r) }));
	},
	async fetch(siteId) {
		const obj = await env.RAW.get(recordKey(siteId));
		if (!obj) return null;
		const record = fromPipelineText(await obj.text());
		if (!record) throw new Error(`${recordKey(siteId)} is not an upload's record`);
		return record;
	}
});
