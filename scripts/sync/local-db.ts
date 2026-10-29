/**
 * The local D1 database (the miniflare file `vite dev` and the render runner use), opened directly
 * with bun:sqlite. It is in WAL mode, so these short reads and writes share it with the dev server
 * and a render run; a write that meets theirs waits up to BUSY_TIMEOUT_MS.
 */
import { Database } from 'bun:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { d1FromSqlite } from '#lib/server/pipeline/d1-sqlite.js';

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
