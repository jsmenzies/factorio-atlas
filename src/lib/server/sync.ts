/** The update's database helpers (sync_runs, sync_meta; migration 0020); its shared parts are in #lib/sync.js. */
import { LIVE_STATES } from '#lib/server/pipeline/runs.js';
import { SYNC_STALE_MS, type SyncControl, type SyncMetaKey, type SyncRun, type SyncRunRow } from '#lib/sync.js';

export const isLiveSync = (run: Pick<SyncRunRow, 'state' | 'updated_at'>, now = Date.now()) =>
	LIVE_STATES.includes(run.state) && now - run.updated_at <= SYNC_STALE_MS;

/**
 * isLiveSync as SQL, for every reader of the table (the runner, the Overview's Stop, the render
 * panel): a WHERE condition on sync_runs and its parameters.
 */
export const LIVE_SYNC_WHERE = `state IN (${LIVE_STATES.map(() => '?').join(', ')}) AND updated_at > ?`;
export const liveSyncParams = (now = Date.now()) => [...LIVE_STATES, now - SYNC_STALE_MS];
/**
 * The environment variable the update sets on its steps' processes: its run id. A script that refuses to run
 * beside a live update (scripts/polled.ts) runs when the live update is the one that started it.
 */
export const SYNC_RUN_ENV = 'ATLAS_SYNC_RUN';
/** Rows in a live state whatever their heartbeat: live ones and those whose runner died. */
export const OPEN_SYNC_WHERE = `state IN (${LIVE_STATES.map(() => '?').join(', ')})`;
export const OPEN_SYNC_PARAMS = [...LIVE_STATES];

/** The runner's heartbeat: upsert its row (every column but `control`) and return the pending control. */
export const writeSyncRun = async (db: D1Database, run: SyncRun): Promise<SyncControl | null> => {
	const row = await db
		.prepare(
			`INSERT INTO sync_runs (id, state, stage, options, sources, steps, started_at, updated_at, finished_at, error)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET state = excluded.state, options = excluded.options, sources = excluded.sources,
				steps = excluded.steps, updated_at = excluded.updated_at, finished_at = excluded.finished_at, error = excluded.error
			RETURNING control`
		)
		.bind(
			run.id,
			run.state,
			run.stage,
			JSON.stringify(run.options),
			JSON.stringify(run.sources),
			JSON.stringify(run.steps),
			run.started_at,
			run.updated_at,
			run.finished_at,
			run.error
		)
		.first<{ control: SyncControl | null }>();
	return row?.control ?? null;
};

/**
 * Ask a live update to stop: 'stop' ends the current step cleanly and starts no more, 'quit' (after a
 * stop that a step didn't answer) passes a second Ctrl-C, which ends it at once. False when no such
 * update is live (or it stopped writing its row).
 */
export const stopSync = async (db: D1Database, id: string, control: SyncControl = 'stop', now = Date.now()) => {
	const r = await db
		.prepare(`UPDATE sync_runs SET control = ? WHERE id = ? AND ${LIVE_SYNC_WHERE}`)
		.bind(control, id, ...liveSyncParams(now))
		.run();
	return (r.meta.changes ?? r.meta.rows_written ?? 0) > 0;
};

export const readMeta = async <T>(db: D1Database, key: SyncMetaKey): Promise<{ value: T; updatedAt: number } | null> => {
	const row = await db
		.prepare('SELECT value, updated_at FROM sync_meta WHERE key = ?')
		.bind(key)
		.first<{ value: string; updated_at: number }>();
	return row ? { value: JSON.parse(row.value) as T, updatedAt: row.updated_at } : null;
};

export const writeMeta = (db: D1Database, key: SyncMetaKey, value: unknown, now = Date.now()) =>
	db
		.prepare(
			'INSERT INTO sync_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
		)
		.bind(key, JSON.stringify(value), now)
		.run();
