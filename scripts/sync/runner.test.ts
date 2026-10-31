import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { d1FromSqlite } from '#lib/server/pipeline/d1-sqlite.js';
import { DEFAULT_SETTINGS, freshSteps, parseSyncRun, sourceDigest, SYNC_STALE_MS, type SyncRun, type SyncRunRow } from '#lib/sync.js';
import {
	backfillComplete,
	polledAdmitStatus,
	backfillSummary,
	claimRun,
	ingestKey,
	lastIngestKey,
	SyncRunner,
	type BackfillResult,
	type StepDef
} from './runner';
import { liveUpdateBesides } from './local-db';
import { SYNC_RUN_ENV } from '#lib/server/sync.js';
import { SHARED_STAGE_ENV } from '../backfill/stage';

const ROOT = join(import.meta.dirname, '..', '..');
const T = 1_800_000_000_000;

/** The real migrations on an in-memory database. */
const fresh = () => {
	const sqlite = new Database(':memory:');
	for (const f of readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.sort())
		sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
	return { sqlite, db: d1FromSqlite(sqlite) };
};

const runAt = (id: string, at: number, over: Partial<SyncRun> = {}): SyncRun => ({
	id,
	state: 'running',
	control: null,
	stage: 'local',
	options: { settings: DEFAULT_SETTINGS, pid: 111, log: 'sync-x.log' },
	sources: [],
	steps: freshSteps(),
	started_at: at,
	updated_at: at,
	finished_at: null,
	error: null,
	...over
});
const rowOf = (sqlite: Database, id: string) => parseSyncRun(sqlite.query('SELECT * FROM sync_runs WHERE id = ?').get(id) as SyncRunRow);
const nobody = () => false;

describe('claimRun', () => {
	test('writes the row when nothing else runs, and refuses a second start while it beats', () => {
		const { sqlite } = fresh();
		expect(claimRun(sqlite, runAt('a', T), T, nobody)).toBeNull();
		expect(rowOf(sqlite, 'a').state).toBe('running');
		expect(claimRun(sqlite, runAt('b', T + 1000), T + 1000, nobody)).toBe('an update is already running (a)');
		expect(sqlite.query("SELECT count(*) AS n FROM sync_runs WHERE id = 'b'").get()).toEqual({ n: 0 });
	});

	test('a row that stopped beating: refused while its processes run, else closed as failed', () => {
		const { sqlite } = fresh();
		const old = runAt('a', T);
		old.options.childPid = 222;
		old.steps[0].status = 'done';
		old.steps[1].status = 'running';
		claimRun(sqlite, old, T, nobody);
		const later = T + SYNC_STALE_MS + 1;
		expect(claimRun(sqlite, runAt('b', later), later, (pid) => pid === 222)).toContain('its processes are still running (pid 222)');
		expect(claimRun(sqlite, runAt('b', later), later, nobody)).toBeNull();
		const closed = rowOf(sqlite, 'a');
		expect(closed.state).toBe('failed');
		expect(closed.error).toContain('stopped responding');
		expect(closed.steps.map((s) => s.status)).toEqual(['done', 'failed', 'stopped', 'stopped', 'stopped', 'stopped', 'stopped']);
		expect(rowOf(sqlite, 'b').state).toBe('running');
	});

	test('refused while a render run is live', () => {
		const { sqlite } = fresh();
		sqlite.run(
			`INSERT INTO render_runs (id, state, host, source, options, started_at, updated_at) VALUES ('r', 'running', 'h', 'clone', '{}', ${T}, ${T})`
		);
		expect(claimRun(sqlite, runAt('a', T), T + 1000, nobody)).toContain('a render run is live (r)');
	});
});

describe('the ingest skip key', () => {
	const withIngest = (
		id: string,
		status: 'done' | 'warning' | 'skipped' | 'failed',
		key?: string,
		state: SyncRun['state'] = 'finished'
	) => {
		const r = runAt(id, T, { state });
		r.steps.find((s) => s.id === 'ingest')!.status = status;
		if (key) r.options.ingestKey = key;
		return r;
	};

	test('waiting uploads never change it (admitted in the fetch); an ingest owed by a failed hand-over does', () => {
		const versions = { analyzer: 10, index: 3 };
		const mirror = { site: 'factorioprints', from: { id: 'a', date: 0 }, to: { id: 'b', date: 0 } };
		const uploads = (id: string) => ({ site: 'uploads', from: null, to: { id, date: 0 }, ingestsItself: true });
		const before = ingestKey(sourceDigest([mirror]), versions);
		expect(ingestKey(sourceDigest([mirror, uploads('3-abc')]), versions)).toBe(before);
		expect(ingestKey(sourceDigest([mirror, uploads('none')]), versions)).toBe(before);
		expect(ingestKey(sourceDigest([mirror, uploads('none')]), versions, '1793300000000')).not.toBe(before);
		expect(ingestKey(sourceDigest([mirror]), versions, null)).toBe(before);
	});

	test("the newest update whose ingest ran to the end, past ones that skipped it (so they don't alternate)", () => {
		expect(lastIngestKey([withIngest('c', 'skipped'), withIngest('b', 'done', 'K2'), withIngest('a', 'done', 'K1')])).toBe('K2');
		expect(lastIngestKey([withIngest('b', 'failed'), withIngest('a', 'warning', 'K1')])).toBe('K1');
		expect(lastIngestKey([withIngest('b', 'done', 'K2', 'stopped'), withIngest('a', 'done', 'K1')])).toBe('K1');
		expect(lastIngestKey([])).toBeUndefined();
	});

	test('saved only when the backfill finished with nothing left to retry', () => {
		const result = (state: string, failures: Record<string, number>): BackfillResult => ({
			id: 'b',
			state,
			total: 10,
			done: 10,
			analysed: 5,
			failed: Object.values(failures).reduce((a, b) => a + b, 0),
			failures
		});
		expect(backfillComplete(result('finished', {}))).toBe(true);
		// The records' own failures are kept in ingest_state: skipped next time anyway.
		expect(backfillComplete(result('finished', { decode: 171, analyze: 2 }))).toBe(true);
		// A storage incident: those prints must be tried again.
		expect(backfillComplete(result('finished', { decode: 1, storage: 40 }))).toBe(false);
		expect(backfillComplete(result('finished', { worker: 1 }))).toBe(false);
		expect(backfillComplete(result('stopped', {}))).toBe(false);
	});

	test('a polled admission: a few records failing after their retries is a warning, a crash or a failed deletion is a failure', () => {
		const counts = { new: 364, joined: 64, updated: 0, unchanged: 0, blocked: 0, undecodable: 0, failed: 0, refetch: 0 };
		const gone = { purged: 0, kept: 0, failed: 0, waiting: 0, edgeNotPurged: 0 };
		const r = (o: Partial<Parameters<typeof polledAdmitStatus>[1] & object> = {}) => ({
			ok: true,
			stopped: false,
			finished: true,
			counts,
			gone,
			...o
		});
		expect(polledAdmitStatus(0, r())).toBe('done');
		// As codex on 2026-10-30: 3 of 431 lost the D1 connection; they're retried next update, authors and render still run.
		expect(polledAdmitStatus(2, r({ ok: false, counts: { ...counts, failed: 3 } }))).toBe('warning');
		expect(polledAdmitStatus(0, r({ counts: { ...counts, blocked: 1 } }))).toBe('warning');
		expect(polledAdmitStatus(2, r({ ok: false, gone: { ...gone, failed: 1 } }))).toBe('failed');
		// Crashed (an error outside a record, before the end), no JSON, or stopped.
		expect(polledAdmitStatus(2, r({ ok: false, finished: false }))).toBe('failed');
		expect(polledAdmitStatus(null, null)).toBe('failed');
		expect(polledAdmitStatus(2, r({ ok: false, finished: false, stopped: true }))).toBe('stopped');
	});

	test("the summary names each outcome some print had, so a re-index doesn't read as nothing", () => {
		const base = { id: 'b', state: 'finished', total: 18_226, done: 18_226, analysed: 0, failed: 0, failures: {} };
		expect(backfillSummary({ ...base, reindexed: 18_046, viewer: 0, favorites: 0, unchanged: 0, skipped: 180 })).toBe(
			'18,046 re-indexed, 0 analysed, 0 failed, 180 known failures skipped'
		);
		expect(backfillSummary({ ...base, analysed: 3, favorites: 12, unchanged: 18_031, skipped: 180, reindexed: 0, viewer: 0 })).toBe(
			'12 favourite counts updated, 3 analysed, 0 failed, 18,031 unchanged, 180 known failures skipped'
		);
		// A backfill from before these fields: the old wording.
		expect(backfillSummary({ ...base, analysed: 2, failed: 1 })).toBe('2 analysed, 1 failed, 18,223 unchanged or known failures');
	});
});

describe('SyncRunner', () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'sync-runner-'));
		// A step that ends cleanly on Ctrl-C, saying how many it got; and one that ignores it.
		writeFileSync(
			join(dir, 'polite.js'),
			"let n = 0; process.on('SIGINT', () => { n++; console.log('INT ' + n); if (n === 1) setTimeout(() => process.exit(0), 300); }); setInterval(() => {}, 1000); console.log('ready');"
		);
		writeFileSync(
			join(dir, 'stubborn.js'),
			"process.on('SIGINT', () => console.log('ignored')); setInterval(() => {}, 1000); console.log('ready');"
		);
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const runner = (name: string, quitGraceMs?: number) => {
		const { sqlite, db } = fresh();
		const run = runAt(name, Date.now());
		claimRun(sqlite, run, Date.now(), nobody);
		return {
			r: new SyncRunner({ db, run, logFile: join(dir, `${name}.log`), cwd: dir, quitGraceMs }),
			log: () => readFileSync(join(dir, `${name}.log`), 'utf8')
		};
	};
	const step = (id: StepDef['id'], over: Partial<StepDef> = {}): StepDef => ({
		id,
		run: async () => ({ status: 'done', summary: id }),
		...over
	});
	const statuses = (r: SyncRunner) => Object.fromEntries(r.run.steps.map((s) => [s.id, s.status]));

	test('gates: a turned-off step and one whose need failed are skipped; the rest run', async () => {
		const { r, log } = runner('gates');
		await r.runSteps([
			step('removals', { gate: () => 'not here yet' }),
			step('fetch'),
			step('ingest', { run: async () => ({ status: 'failed', summary: 'storage down' }) }),
			step('authors', { needs: ['ingest'] }),
			step('screenshots', { run: async () => ({ status: 'warning', summary: 'imgur refused' }) }),
			step('render', { needs: ['ingest'] }),
			step('figures')
		]);
		const done = await r.finish();
		expect(statuses(r)).toEqual({
			removals: 'skipped',
			fetch: 'done',
			ingest: 'failed',
			authors: 'skipped',
			screenshots: 'warning',
			render: 'skipped',
			figures: 'done'
		});
		expect(r.run.steps.find((s) => s.id === 'render')!.summary).toBe('needs "update the site\'s prints", which failed');
		expect(done.state).toBe('finished');
		expect(done.error).toBe("Update the site's prints: storage down");
		expect(log()).toContain(`sync gates: finished (Update the site's prints: storage down)`);
	});

	test('a stop mid-step: that step stopped (a real failure stays failed), the rest not run', async () => {
		const { r } = runner('stop');
		await r.runSteps([
			step('removals'),
			step('fetch', {
				run: async () => {
					r.requestStop('test');
					return { status: 'done' };
				}
			}),
			step('ingest'),
			step('figures')
		]);
		expect(statuses(r)).toMatchObject({ removals: 'done', fetch: 'stopped', ingest: 'stopped', figures: 'stopped' });
		expect((await r.finish()).state).toBe('stopped');

		const { r: r2 } = runner('stop-failed');
		await r2.runSteps([
			step('fetch', {
				run: async () => {
					r2.requestStop('test');
					return { status: 'failed', summary: 'broke', code: 1 };
				}
			}),
			step('ingest', {
				run: async () => ({ status: 'failed', code: 130 })
			})
		]);
		expect(statuses(r2)).toMatchObject({ fetch: 'failed', ingest: 'stopped' });
		await r2.finish();
	});

	test('one stop request is one Ctrl-C to the step, which ends cleanly; its output is in the log', async () => {
		const { r, log } = runner('polite');
		const started = r.runScript([join(dir, 'polite.js')]);
		await waitFor(() => log().includes('ready'));
		expect(typeof r.run.options.childPid).toBe('number');
		r.requestStop('test');
		const res = await started;
		expect(res.code).toBe(0);
		expect(res.tail).toContain('INT 1');
		expect(res.tail).not.toContain('INT 2');
		expect(r.run.options.childPid).toBeUndefined();
		await r.finish();
	});

	test("a step's process is told the update's run id, so a script that refuses beside an update runs as its step", async () => {
		const { r } = runner('own-step');
		writeFileSync(join(dir, 'env.js'), `console.log('run=' + process.env.${SYNC_RUN_ENV})`);
		expect((await r.runScript([join(dir, 'env.js')])).tail).toContain('run=own-step');
		await r.finish();
	});

	test("a step's process sees the update's shared stage (set in the runner's environment once it is open)", async () => {
		const { r } = runner('shared-stage');
		writeFileSync(join(dir, 'shared.js'), `console.log('shared=' + process.env.${SHARED_STAGE_ENV})`);
		process.env[SHARED_STAGE_ENV] = '{"stage":"prod"}';
		try {
			expect((await r.runScript([join(dir, 'shared.js')])).tail).toContain('shared={"stage":"prod"}');
		} finally {
			delete process.env[SHARED_STAGE_ENV];
		}
		expect((await r.runScript([join(dir, 'shared.js')])).tail).toContain('shared=undefined');
		await r.finish();
	});

	test('Quit on a step that ignores Ctrl-C: its group is killed after the grace', async () => {
		const { r, log } = runner('stubborn', 300);
		const started = r.runScript([join(dir, 'stubborn.js')]);
		await waitFor(() => log().includes('ready'));
		r.requestStop('test');
		r.requestStop('test');
		const res = await started;
		expect(res.code).toBe(137);
		expect(log()).toContain('killed');
		await r.finish();
	});
});

async function waitFor(ok: () => boolean, ms = 5000) {
	const end = Date.now() + ms;
	while (!ok()) {
		if (Date.now() > end) throw new Error('timed out');
		await new Promise((r) => setTimeout(r, 20));
	}
}

describe('liveUpdateBesides', () => {
	test("a live update other than the caller's own; none when stale, or with no sync tables", () => {
		const { sqlite } = fresh();
		expect(liveUpdateBesides(sqlite, null, T)).toBeNull();
		claimRun(sqlite, runAt('a', T), T, nobody);
		expect(liveUpdateBesides(sqlite, null, T)).toBe('a');
		expect(liveUpdateBesides(sqlite, 'b', T)).toBe('a');
		expect(liveUpdateBesides(sqlite, 'a', T)).toBeNull();
		expect(liveUpdateBesides(sqlite, null, T + SYNC_STALE_MS + 1)).toBeNull();
		expect(liveUpdateBesides(new Database(':memory:'), null, T)).toBeNull();
	});
});
