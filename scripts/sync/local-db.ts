/**
 * The local D1 database (the miniflare file `vite dev` and the render runner use), opened directly
 * with bun:sqlite. It is in WAL mode, so these short reads and writes share it with the dev server
 * and a render run; a write that meets theirs waits up to BUSY_TIMEOUT_MS.
 */
import { Database } from 'bun:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { d1FromSqlite } from '#lib/server/pipeline/d1-sqlite.js';
import { LIVE_SYNC_WHERE, liveSyncParams, SYNC_RUN_ENV } from '#lib/server/sync.js';

const BUSY_TIMEOUT_MS = 10_000;

/** The miniflare file under `root`, or null when `bun run db:migrate` hasn't made one. */
export const localDbFile = (root: string): string | null => {
	const dir = join(root, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
	try {
		const file = readdirSync(dir).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
		return file ? join(dir, file) : null;
	} catch {
		return null;
	}
};

/** `db` for ordinary reads and writes; `sqlite` for the few that need a transaction of their own. */
export const openLocalDb = (file: string): { db: D1Database; sqlite: Database; close: () => void } => {
	const sqlite = new Database(file);
	sqlite.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
	return { db: d1FromSqlite(sqlite), sqlite, close: () => sqlite.close() };
};

/**
 * The id of a live update (LIVE_SYNC_WHERE) in the local D1 under `root` that didn't start this process (its
 * steps carry SYNC_RUN_ENV); null when there is none, no local D1, or no sync tables yet.
 */
export const otherLiveUpdate = (root: string, env: Record<string, string | undefined> = process.env, now = Date.now()): string | null => {
	const file = localDbFile(root);
	if (!file) return null;
	const sqlite = new Database(file);
	try {
		sqlite.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		return liveUpdateBesides(sqlite, env[SYNC_RUN_ENV] ?? null, now);
	} finally {
		sqlite.close();
	}
};

/** otherLiveUpdate on an open database: a live update other than `own`, else null (also with no sync tables). */
export const liveUpdateBesides = (sqlite: Database, own: string | null, now = Date.now()): string | null => {
	try {
		const row = sqlite
			.query(`SELECT id FROM sync_runs WHERE ${LIVE_SYNC_WHERE} AND id IS NOT ? LIMIT 1`)
			.get(...liveSyncParams(now), own) as {
			id: string;
		} | null;
		return row?.id ?? null;
	} catch (e) {
		if (/no such table/.test(e instanceof Error ? e.message : String(e))) return null;
		throw e;
	}
};
