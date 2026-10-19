import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { etaSeconds, fmtRate, RateWindow, sampleBySize, statusLine, statusLines } from './backfill';
import { fixtureRecord } from '#lib/server/fixtures.js';
import { fullRunEstimate } from '#lib/run-estimate.js';
import { d1FromSqlite } from './d1-sqlite';
import { applyPlan, ingestText, planFailure, planIngest, type IngestPlan } from './pipeline';
import { RawStore } from './raw-store';
import { INDEX_VERSION, loadIngestStates, PrintRepository, PrintRepositoryD1 } from './repository';
import { clearControl, failureBucket, latestRuns, newRunId, writeRun, type PipelineRun, type PipelineRunRow } from './runs';

const ROOT = join(import.meta.dirname, '../../../..');
const ID = '-KYpTULTDIvDOsJfgjeS';
const FIXTURE = await fixtureRecord(ID);
const BOOK_ID = '-KnQ865j-qQ21WoUPbd3';
const BOOK = await fixtureRecord(BOOK_ID);

/** Real migrations and repository over bun:sqlite, an in-memory R2, and every D1 write counted. */
const setup = () => {
	const sqlite = new Database(':memory:');
	for (const f of readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.sort()) {
		sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
	}
	const db = d1FromSqlite(sqlite);
	const r2 = new Map<string, string>();
	const writes: Record<string, number> = {};
	const layer = Layer.mergeAll(
		PrintRepositoryD1(db, { onWrite: (op, rows) => (writes[op] = (writes[op] ?? 0) + rows) }),
		Layer.succeed(RawStore, {
			put: (k, v) => Effect.sync(() => void r2.set(k, v)),
			get: (k) => Effect.succeed(r2.get(k) ?? null),
			delete: (k) => Effect.sync(() => void r2.delete(k))
		})
	);
	const run = <A, E>(effect: Effect.Effect<A, E, PrintRepository | RawStore>) => Effect.runPromise(Effect.provide(effect, layer));
	const state = (id: string) =>
		run(
			Effect.gen(function* () {
				return yield* (yield* PrintRepository).getState(id);
			})
		);
	return { sqlite, db, r2, writes, run, state };
};

describe('sampleBySize', () => {
	const entries = Array.from({ length: 1000 }, (_, i) => ({ id: `id${String(i).padStart(4, '0')}`, size: (i * 7919) % 1000 }));

	test('n prints, always including the smallest and the largest, in source order', () => {
		const sample = sampleBySize(entries, 50);
		expect(sample.length).toBe(50);
		const sizes = sample.map((e) => e.size);
		expect(Math.min(...sizes)).toBe(0);
		expect(Math.max(...sizes)).toBe(999);
		expect(sample).toEqual(entries.filter((e) => sample.includes(e)));
	});

	test('spread evenly over sizes, and deterministic', () => {
		const sizes = sampleBySize(entries, 11)
			.map((e) => e.size)
			.sort((a, b) => a - b);
		expect(sizes).toEqual([0, 100, 200, 300, 400, 500, 599, 699, 799, 899, 999]);
		expect(sampleBySize(entries, 11)).toEqual(sampleBySize([...entries].reverse(), 11).reverse());
	});

	test('edge cases: all, none, one', () => {
		expect(sampleBySize(entries, 5000).length).toBe(1000);
		expect(sampleBySize(entries, 0)).toEqual([]);
		expect(sampleBySize(entries, 1).length).toBe(1);
	});
});

describe('RateWindow and ETA', () => {
	test('overall rate until the window is full, then the last 5 minutes only', () => {
		const w = new RateWindow(300_000);
		w.reset(0, 0);
		expect(w.rate()).toBe(null);
		// 10/s for 4 minutes: still the overall rate.
		for (let s = 1; s <= 240; s++) w.add(s * 1000, s * 10);
		expect(w.rate()).toBeCloseTo(10);
		// Then 1/s for 10 minutes: the window forgets the fast start.
		for (let s = 241; s <= 840; s++) w.add(s * 1000, 2400 + (s - 240));
		expect(w.rate()).toBeCloseTo(1, 1);
	});

	test('reset after a pause drops the paused time', () => {
		const w = new RateWindow();
		w.reset(0, 0);
		w.add(10_000, 100);
		w.reset(1_000_000, 100);
		w.add(1_010_000, 200);
		expect(w.rate()).toBeCloseTo(10);
	});

	test('ETA and rate formatting', () => {
		expect(etaSeconds(100, 4)).toBe(25);
		expect(etaSeconds(100, null)).toBe(null);
		expect(etaSeconds(0, null)).toBe(0);
		expect(fmtRate(12.3)).toBe('12/s');
		expect(fmtRate(2.25)).toBe('2.3/s');
		expect(fmtRate(0.5)).toBe('30.0/min');
	});
});

describe('runs', () => {
	test('failureBucket is the reason prefix', () => {
		expect(failureBucket('decode: zlib')).toBe('decode');
		expect(failureBucket('analyze v6: TypeError: x')).toBe('analyze');
		expect(failureBucket('timeout: analysis took over 10 s')).toBe('timeout');
		expect(failureBucket('fetch: HTTP 500 from raw')).toBe('fetch');
		expect(failureBucket('parse: record does not match the schema')).toBe('parse');
		expect(failureBucket('???')).toBe('other');
	});

	test('run ids sort by start time', () => {
		expect(/^2026-10-19T07:05:12Z-[a-z0-9]{4}$/.test(newRunId(new Date('2026-10-19T07:05:12.345Z')))).toBe(true);
	});

	const row = (patch: Partial<PipelineRunRow> = {}): Omit<PipelineRunRow, 'control'> => ({
		id: 'r1',
		kind: 'backfill',
		stage: 'local',
		host: 'test',
		source: 'mirror@96d6afa',
		options: JSON.stringify({ limit: 50, concurrency: 8, force: false, retryFailed: false, corpus: 18142 }),
		state: 'running',
		total: 50,
		done: 10,
		analysed: 8,
		viewer: 0,
		reindexed: 0,
		unchanged: 1,
		favorites: 0,
		failed: 1,
		skipped_failed: 0,
		failures: JSON.stringify({ decode: 1 }),
		rows_written: 184,
		r2_objects: 200,
		r2_bytes: 3_000_000,
		source_bytes: 0,
		rate: 2,
		eta_seconds: 20,
		started_at: 1000,
		updated_at: 2000,
		finished_at: null,
		error: null,
		...patch
	});

	test('the heartbeat never overwrites control; clearing only clears what was acted on', async () => {
		const { db, sqlite } = setup();
		expect(await writeRun(db, row())).toBe(null);
		sqlite.run(`UPDATE pipeline_runs SET control = 'pause' WHERE id = 'r1'`);
		expect(await writeRun(db, row({ done: 20, updated_at: 3000 }))).toBe('pause');
		expect(await writeRun(db, row({ done: 21, updated_at: 4000 }))).toBe('pause');
		// The admin page asked for something else meanwhile: that stays.
		sqlite.run(`UPDATE pipeline_runs SET control = 'stop' WHERE id = 'r1'`);
		await clearControl(db, 'r1', 'pause');
		expect(await writeRun(db, row({ state: 'paused' }))).toBe('stop');
		await clearControl(db, 'r1', 'stop');
		expect(await writeRun(db, row({ state: 'stopping' }))).toBe(null);
		const [run] = await latestRuns(db);
		expect(run.state).toBe('stopping');
		expect(run.started_at).toBe(1000);
		expect(run.failures).toEqual({ decode: 1 });
	});

	test('full-run R2 projections scale by mirror bytes, rows per print', () => {
		// The 100-print dev sample: 98 writers, 16.2 MB of mirror records (with the 10.1 MB book).
		const run: PipelineRun = {
			...row({ analysed: 97, failed: 1, rows_written: 1413, r2_objects: 3398, r2_bytes: 26_000_000, source_bytes: 16_200_000 }),
			control: null,
			options: { limit: 100, concurrency: 24, force: false, retryFailed: false, corpus: 18_142, corpusBytes: 1_515_000_000 },
			failures: {}
		};
		const full = fullRunEstimate(run)!;
		expect(full.byBytes).toBe(true);
		expect(Math.round(full.rows / 1000)).toBe(262);
		expect(Math.round(full.bytes / 1e8) / 10).toBe(2.4);
		expect(Math.round(full.objects / 1000)).toBe(318);
		// Without corpusBytes (older runs) it falls back to per-print averages.
		expect(fullRunEstimate({ ...run, options: { ...run.options, corpusBytes: undefined } })!.byBytes).toBe(false);
	});

	test('runs from a database before migration 0009 (no `reindexed`) still read and project', async () => {
		const sqlite = new Database(':memory:');
		for (const f of readdirSync(join(ROOT, 'migrations'))
			.filter((f) => f.endsWith('.sql') && f < '0009')
			.sort()) {
			sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
		}
		const { reindexed: _reindexed, ...old } = row();
		const columns = Object.keys(old);
		sqlite
			.query(`INSERT INTO pipeline_runs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
			.run(...(Object.values(old) as (string | number | null)[]));
		const [run] = await latestRuns(d1FromSqlite(sqlite));
		expect(run.reindexed).toBe(0);
		expect(fullRunEstimate(run)!.rows).toBeGreaterThan(0);
		expect(statusLines(run, 2000).join('\n').includes('NaN')).toBe(false);
		expect(statusLine(run, 2000).includes('NaN')).toBe(false);
	});

	test('status lines show progress, outcomes, projections and failures', () => {
		const run: PipelineRun = { ...row(), control: null, options: JSON.parse(row().options), failures: { decode: 1 } };
		const lines = statusLines(run, 2000, { slowest: { id: 'x', ms: 885, bytes: 10_100_000 } });
		expect(lines[1].includes('10/50 · 40 left')).toBe(true);
		expect(lines[2].includes('✓ 8 analysed  ✗ 1 failed  ↷ 1 skipped')).toBe(true);
		expect(lines[4].includes('184 rows written · 20.4/print · full run of 18,142 ≈ 371k (0.7% of 50M/month)')).toBe(true);
		expect(lines[6].includes('failures: decode 1')).toBe(true);
		expect(lines[6].includes('slowest x 885 ms (10.1 MB)')).toBe(true);
		expect(statusLine(run, 2000).includes('10/50 20%')).toBe(true);
	});
});

describe('compute/write split', () => {
	/** As the backfill does it: plan in a worker (structured clone both ways), then apply in the parent. */
	const viaWorker = async (h: ReturnType<typeof setup>, id: string, text: string) => {
		const states = await loadIngestStates(h.db);
		const plan = structuredClone(
			await Effect.runPromise(planIngest(id, text, 'test', structuredClone(states.get(id) ?? null), { maxInflatedBytes: 192 << 20 }))
		);
		return { plan, outcome: await h.run(applyPlan(plan)) };
	};

	test('planIngest + applyPlan stores exactly what ingestText does', async () => {
		const a = setup();
		const b = setup();
		const viaPlan = await viaWorker(a, BOOK_ID, BOOK);
		const direct = await b.run(ingestText(BOOK_ID, BOOK, 'test'));
		expect(viaPlan.outcome).toEqual(direct);
		expect(new Map(a.r2)).toEqual(new Map(b.r2));
		const dump = (h: ReturnType<typeof setup>) => h.sqlite.query(`SELECT id, title, outputs, claimed_versions, planets FROM prints`).all();
		expect(dump(a)).toEqual(dump(b));
		const state = (h: ReturnType<typeof setup>) =>
			h.sqlite.query(`SELECT print_id, content_sha256, status, analyzer_version, viewer_version, favorites FROM ingest_state`).all();
		expect(state(a)).toEqual(state(b));
		// The real rows_written reached the hook.
		expect(a.writes.upsert).toBe(direct.status === 'analysed' ? direct.rowsWritten : -1);
		expect(a.writes.upsert).toBeGreaterThan(5);
	});

	test('the second run is planned as unchanged and writes nothing', async () => {
		const h = setup();
		await viaWorker(h, ID, FIXTURE);
		const before = { ...h.writes };
		const again = await viaWorker(h, ID, FIXTURE);
		expect(again.plan).toEqual({ kind: 'unchanged', id: ID });
		expect(h.writes).toEqual(before);
	});

	test('a favourites-only change is planned as a refresh', async () => {
		const h = setup();
		await viaWorker(h, ID, FIXTURE);
		const r = JSON.parse(FIXTURE) as Record<string, unknown>;
		r.numberOfFavorites = 4242;
		const { plan, outcome } = await viaWorker(h, ID, JSON.stringify(r));
		expect(plan).toEqual({ kind: 'refresh', id: ID, favorites: 4242, viewerFiles: null, reindex: null });
		expect(outcome).toEqual({ status: 'favorites', id: ID, favorites: 4242 });
		expect(h.writes.updateFavorites).toBe(2);
	});

	test('rows from an older INDEX_VERSION are rewritten from R2 alone, identically, then left alone', async () => {
		const h = setup();
		await viaWorker(h, BOOK_ID, BOOK);
		const rows = () => ({
			search: h.sqlite.query('SELECT * FROM print_search').all(),
			items: h.sqlite.query('SELECT * FROM print_items ORDER BY role, item').all(),
			uses: h.sqlite.query('SELECT * FROM print_uses ORDER BY entity').all()
		});
		const before = rows();
		// Only the curated buildings get rows: belts, inserters, poles and pipes are tokens only.
		expect(before.uses).toEqual([{ print_id: BOOK_ID, entity: 'entity:assembling-machine-2' }]);
		expect(String((before.search[0] as { facets: string }).facets).includes('uses_entity_fast_inserter')).toBe(true);
		const r2 = new Map(h.r2);
		// As every row is right after migration 0009.
		h.sqlite.run('UPDATE ingest_state SET index_version = NULL');
		const upserted = h.writes.upsert;
		const { plan, outcome } = await viaWorker(h, BOOK_ID, BOOK);
		expect(plan.kind === 'refresh' && plan.reindex !== null && plan.viewerFiles === null).toBe(true);
		expect(outcome.status).toBe('reindexed');
		expect(rows()).toEqual(before);
		expect(new Map(h.r2)).toEqual(r2);
		expect((await h.state(BOOK_ID))?.indexVersion).toBe(INDEX_VERSION);
		expect(h.writes.upsert - upserted).toBe(outcome.status === 'reindexed' ? outcome.rowsWritten : -1);
		expect((await viaWorker(h, BOOK_ID, BOOK)).plan).toEqual({ kind: 'unchanged', id: BOOK_ID });
	});

	test('a timeout is recorded as failed and then skipped until the content changes', async () => {
		const h = setup();
		const plan: IngestPlan = await Effect.runPromise(planFailure(ID, FIXTURE, null, 'timeout: analysis took over 10 s'));
		expect(plan.kind === 'failed' && plan.archive !== null).toBe(true);
		expect(await h.run(applyPlan(plan))).toEqual({ status: 'failed', id: ID, reason: 'timeout: analysis took over 10 s' });
		expect((await h.state(ID))?.status).toBe('failed');
		expect(h.r2.has(`analysis/${ID}.json`)).toBe(false);
		expect((await viaWorker(h, ID, FIXTURE)).plan).toEqual({ kind: 'skipped-failed', id: ID, reason: 'timeout: analysis took over 10 s' });
		// Same content as stored: no archive rewrite.
		const again = await Effect.runPromise(planFailure(ID, FIXTURE, await h.state(ID), 'timeout: x'));
		expect(again.kind === 'failed' && again.archive).toBe(null);
		// --retry-failed analyses it.
		const states = await loadIngestStates(h.db);
		const retry = await Effect.runPromise(planIngest(ID, FIXTURE, 'test', states.get(ID) ?? null, { retryFailed: true }));
		expect(retry.kind).toBe('analysed');
	});

	test('loadIngestStates pages through every row', async () => {
		const h = setup();
		const stmt = h.sqlite.query(
			`INSERT INTO ingest_state (print_id, content_sha256, status, favorites, checked_at) VALUES (?, 'x', 'ok', 0, 0)`
		);
		for (let i = 0; i < 25; i++) stmt.run(`p${String(i).padStart(2, '0')}`);
		const states = await loadIngestStates(h.db, 10);
		expect(states.size).toBe(25);
		expect(states.get('p24')?.contentSha256).toBe('x');
	});
});
