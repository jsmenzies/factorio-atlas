import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, freshSteps, parseSyncRun, SYNC_STALE_MS, type SyncRun, type SyncRunRow } from '#lib/sync.js';
import { d1FromSqlite } from './pipeline/d1-sqlite';
import { isLiveSync, readMeta, stopSync, writeMeta, writeSyncRun } from './sync';

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** The real migrations on an in-memory database. */
const fresh = () => {
	const sqlite = new Database(':memory:');
	for (const f of readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.sort())
		sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
	return d1FromSqlite(sqlite);
};

const T = 1_800_000_000_000;
const runAt = (now: number): SyncRun => ({
	id: 'r1',
	state: 'running',
	control: null,
	stage: 'local',
	options: { settings: DEFAULT_SETTINGS, pid: 1, log: 'sync-x.log' },
	sources: [],
	steps: freshSteps(),
	started_at: T,
	updated_at: now,
	finished_at: null,
	error: null
});
const row = (db: D1Database) => db.prepare("SELECT * FROM sync_runs WHERE id = 'r1'").first<SyncRunRow>();

describe('sync_runs', () => {
	test('the heartbeat upserts the row, options included, and hands back a pending stop or quit', async () => {
		const db = fresh();
		const run = runAt(T);
		expect(await writeSyncRun(db, run)).toBeNull();
		run.options.childPid = 42;
		run.steps[0].status = 'done';
		expect(await writeSyncRun(db, { ...run, updated_at: T + 5000 })).toBeNull();
		const read = parseSyncRun((await row(db))!);
		expect(read.options.childPid).toBe(42);
		expect(read.steps[0].status).toBe('done');

		expect(await stopSync(db, 'r1', 'stop', T + 6000)).toBe(true);
		// The heartbeat never clears control: the runner reads it on every beat.
		expect(await writeSyncRun(db, { ...run, updated_at: T + 10_000 })).toBe('stop');
		expect(await stopSync(db, 'r1', 'quit', T + 11_000)).toBe(true);
		expect(await writeSyncRun(db, { ...run, updated_at: T + 15_000 })).toBe('quit');
	});

	test('Stop does nothing to an update that ended or stopped writing its row', async () => {
		const db = fresh();
		await writeSyncRun(db, runAt(T));
		expect(await stopSync(db, 'r1', 'stop', T + SYNC_STALE_MS + 1)).toBe(false);
		expect(await stopSync(db, 'nope', 'stop', T)).toBe(false);
		await writeSyncRun(db, { ...runAt(T), state: 'finished', finished_at: T });
		expect(await stopSync(db, 'r1', 'stop', T)).toBe(false);
		expect((await row(db))!.control).toBeNull();
	});

	test('isLiveSync: a live state written within SYNC_STALE_MS', () => {
		expect(isLiveSync({ state: 'running', updated_at: T }, T + SYNC_STALE_MS)).toBe(true);
		expect(isLiveSync({ state: 'stopping', updated_at: T }, T + SYNC_STALE_MS + 1)).toBe(false);
		expect(isLiveSync({ state: 'finished', updated_at: T }, T)).toBe(false);
	});
});

describe('sync_meta', () => {
	test('writes and reads back JSON values with their time', async () => {
		const db = fresh();
		expect(await readMeta(db, 'settings')).toBeNull();
		await writeMeta(db, 'settings', { top: 5 }, T);
		await writeMeta(db, 'settings', { top: 6 }, T + 1);
		expect(await readMeta(db, 'settings')).toEqual({ value: { top: 6 }, updatedAt: T + 1 });
	});
});
