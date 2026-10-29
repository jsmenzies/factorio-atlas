import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { fixtureRecord } from '#lib/server/fixtures.js';
import { d1FromSqlite } from './pipeline/d1-sqlite';
import { encodeExchangeString } from './pipeline/decode';
import { applyPlan, ingestText, planIngest } from './pipeline/pipeline';
import { RawStore } from './pipeline/raw-store';
import { PrintRepositoryD1 } from './pipeline/repository';
import { isPrintRemoved } from './removal-blocks';
import { deletePrefix, purgePrintData, TakedownError, takedownPrint, type TakedownEnv } from './takedown';

const ROOT = join(import.meta.dirname, '../../..');
const ID = '-KYpTULTDIvDOsJfgjeS';
const FIXTURE = await fixtureRecord(ID);
const IMAGE = (JSON.parse(FIXTURE) as { image: { id: string } }).image.id;

/** Just enough of R2 for the takedown: list by prefix in pages, delete, put. */
const bucket = (objects = new Map<string, string>()) =>
	Object.assign(
		{
			list: async ({ prefix = '', cursor, limit = 1000 }: R2ListOptions = {}) => {
				const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
				const start = cursor ? Number(cursor) : 0;
				const page = keys.slice(start, start + limit);
				const truncated = start + limit < keys.length;
				return { objects: page.map((key) => ({ key })), truncated, cursor: truncated ? String(start + limit) : undefined };
			},
			delete: async (keys: string | string[]) => {
				for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
			},
			put: async (key: string, body: string) => void objects.set(key, body)
		} as unknown as R2Bucket,
		{ objects }
	);

const setup = async () => {
	const sqlite = new Database(':memory:');
	for (const f of readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.sort()) {
		sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
	}
	const db = d1FromSqlite(sqlite);
	const raw = bucket();
	const layer = Layer.mergeAll(
		PrintRepositoryD1(db),
		Layer.succeed(RawStore, {
			put: (k, v) => Effect.sync(() => void raw.objects.set(k, v)),
			get: (k) => Effect.succeed(raw.objects.get(k) ?? null),
			delete: (k) => Effect.sync(() => void raw.objects.delete(k))
		})
	);
	const ingest = () => Effect.runPromise(Effect.provide(ingestText(ID, FIXTURE, 'test'), layer));
	/** A backfill's two halves: plan now (as the run read the blocks), store later. */
	const plan = (force = false) => Effect.runPromise(Effect.provide(planIngest(ID, FIXTURE, 'test', null, { force }), layer));
	const apply = (p: Awaited<ReturnType<typeof plan>>) => Effect.runPromise(Effect.provide(applyPlan(p), layer));
	await ingest();
	const renders = bucket(
		new Map([
			[`${ID}/index.json`, '{}'],
			[`${ID}/0.123.avif`, ''],
			...Array.from({ length: 2500 }, (_, i) => [`${ID}/t/${i}.avif`, ''] as [string, string]),
			['-Other/index.json', '{}']
		])
	);
	const shots = bucket(
		new Map([
			[`${IMAGE}.png`, ''],
			[`${IMAGE}.v1.c320.avif`, ''],
			[`${IMAGE}.json`, '{"state":"copied"}'],
			['Other12.png', '']
		])
	);
	const env: TakedownEnv = {
		DB: db,
		RAW: raw,
		RENDERS: renders,
		SCREENSHOTS: shots,
		RENDERS_URL: 'https://renders.example.com',
		SCREENSHOTS_URL: 'https://shots.example.com'
	};
	const count = (sql: string) => (sqlite.query(sql).get(ID) as { n: number }).n;
	return { sqlite, db, raw, renders, shots, env, ingest, plan, apply, count };
};

describe('takedownPrint', () => {
	test('blocks the print, deletes its rows and files, keeps everyone else’s', async () => {
		const h = await setup();
		expect(h.count('SELECT count(*) AS n FROM prints WHERE id = ?')).toBe(1);
		expect([...h.raw.objects.keys()].some((k) => k.startsWith(`viewer/${ID}/`))).toBe(true);

		const r = await takedownPrint(h.env, ID, 'rep1', { now: 5 });
		expect(await isPrintRemoved(h.db, ID)).toBe(true);
		for (const table of ['prints WHERE id = ?', 'print_search WHERE print_id = ?', 'print_items WHERE print_id = ?']) {
			expect(h.count(`SELECT count(*) AS n FROM ${table}`)).toBe(0);
		}
		expect(h.count('SELECT count(*) AS n FROM ingest_state WHERE print_id = ?')).toBe(0);
		expect(h.sqlite.query('SELECT kind, at FROM print_tombstones WHERE print_id = ?').get(ID)).toEqual({ kind: 'takedown', at: 5 });
		expect([...h.raw.objects.keys()]).toEqual([]);
		expect([...h.renders.objects.keys()]).toEqual(['-Other/index.json']);
		expect(r.renderObjects).toBe(2502);
		// No other print uses its image, so the screenshot goes, leaving a 'removed' manifest.
		expect(r.screenshot).toBe('removed');
		expect([...h.shots.objects.keys()].sort()).toEqual(['Other12.png', `${IMAGE}.json`]);
		expect(h.shots.objects.get(`${IMAGE}.json`)).toBe('{"state":"removed"}');
		expect(h.sqlite.query('SELECT state FROM screenshots WHERE image_id = ?').get(IMAGE)).toEqual({ state: 'removed' });
		expect(h.sqlite.query(`SELECT value FROM removal_blocks WHERE kind = 'image'`).all()).toEqual([{ value: IMAGE }]);
		// Nothing purged without a token, but the result says what to purge.
		expect(r.purged).toBe(false);
		expect(r.purge.prefixes).toEqual([`renders.example.com/${ID}/`]);
		expect(r.purge.urls).toContain(`https://shots.example.com/${IMAGE}.png`);
		expect(r.purge.urls).toContain(`https://shots.example.com/${IMAGE}.json`);
	});

	test('the pipeline never writes it again', async () => {
		const h = await setup();
		await takedownPrint(h.env, ID, null);
		const outcome = await h.ingest();
		expect(outcome.status).toBe('removed');
		expect(h.count('SELECT count(*) AS n FROM prints WHERE id = ?')).toBe(0);
		expect([...h.raw.objects.keys()]).toEqual([]);
	});

	test('running it again after it was cut short finishes, and changes nothing more', async () => {
		const h = await setup();
		await takedownPrint(h.env, ID, null);
		h.renders.objects.set(`${ID}/late.avif`, '');
		const again = await takedownPrint(h.env, ID, null);
		expect(again.renderObjects).toBe(1);
		// The image comes from the block, as the prints row is gone.
		expect(again.screenshot).toBe('removed');
		// print, source, image, and the print's content hash (it has one page: whole print = page).
		expect(h.count('SELECT count(*) AS n FROM removal_blocks WHERE print_id = ?')).toBe(4);
	});

	test('a RAW delete that fails: blocked and 410 already, the page cache bumped, and running it again finishes', async () => {
		const h = await setup();
		const failing = { ...h.env, RAW: { ...h.raw, delete: async () => Promise.reject(new Error('R2 is down')) } as unknown as R2Bucket };
		const err = await takedownPrint(failing, ID, null, { now: 7 }).catch((e: unknown) => e);
		expect(err instanceof TakedownError).toBe(true);
		expect((err as TakedownError).purge).toEqual({ prefixes: [`renders.example.com/${ID}/`], urls: [] });
		// The analysis document is still in R2, but the tombstone makes every page answer 410 (loadPrintDoc),
		// and the blocks make the database refuse the print's row.
		expect([...h.raw.objects.keys()]).toContain(`analysis/${ID}.json`);
		expect(h.sqlite.query('SELECT kind FROM print_tombstones WHERE print_id = ?').get(ID)).toEqual({ kind: 'takedown' });
		expect(await isPrintRemoved(h.db, ID)).toBe(true);
		expect(h.sqlite.query(`SELECT value FROM meta WHERE key = 'sync_version'`).get()).toEqual({ value: '7' });
		const done = await takedownPrint(h.env, ID, null);
		expect(done.screenshot).toBe('removed');
		expect([...h.raw.objects.keys()]).toEqual([]);
		expect(h.count('SELECT count(*) AS n FROM prints WHERE id = ?')).toBe(0);
	});

	test('the database refuses the print’s row once it is blocked, however the write is made', async () => {
		const h = await setup();
		await takedownPrint(h.env, ID, null);
		const columns = (h.sqlite.query('PRAGMA table_info(prints)').all() as { name: string; notnull: number; dflt_value: unknown }[]).filter(
			(c) => c.name === 'id' || (c.notnull && c.dflt_value === null)
		);
		const values = columns.map((c) => (c.name === 'id' ? `'${ID}'` : `0`)).join(', ');
		for (const sql of [
			`INSERT INTO prints (${columns.map((c) => c.name).join(', ')}) VALUES (${values})`,
			`INSERT OR REPLACE INTO prints (${columns.map((c) => c.name).join(', ')}) VALUES (${values})`,
			`INSERT INTO prints (${columns.map((c) => c.name).join(', ')}) VALUES (${values}) ON CONFLICT (id) DO UPDATE SET title = 'x'`
		]) {
			expect(() => h.sqlite.run(sql)).toThrow('print removed on request');
		}
		expect(h.count('SELECT count(*) AS n FROM prints WHERE id = ?')).toBe(0);
	});

	test('an approval that lands mid-backfill: the run’s plan can’t bring the print back', async () => {
		const h = await setup();
		// The run planned the print (forced: a full re-analysis) before the approval...
		const planned = await h.plan(true);
		expect(planned.kind).toBe('analysed');
		await takedownPrint(h.env, ID, null);
		// ...and stores it after: refused, and its R2 writes undone.
		expect(await h.apply(planned)).toEqual({ status: 'removed', id: ID });
		expect(h.count('SELECT count(*) AS n FROM prints WHERE id = ?')).toBe(0);
		expect(h.count('SELECT count(*) AS n FROM print_search WHERE print_id = ?')).toBe(0);
		expect(h.count('SELECT count(*) AS n FROM ingest_state WHERE print_id = ?')).toBe(0);
		expect([...h.raw.objects.keys()]).toEqual([]);
		expect(h.sqlite.query('SELECT kind FROM print_tombstones WHERE print_id = ?').get(ID)).toEqual({ kind: 'takedown' });
	});

	test('a screenshot another print shares stays, unless the request was about it', async () => {
		const h = await setup();
		// Another print with the same Imgur image.
		const columns = (h.sqlite.query('PRAGMA table_info(prints)').all() as { name: string }[]).map((c) => c.name);
		const values = columns.map((c) => (c === 'id' ? `'-Twin'` : c)).join(', ');
		h.sqlite.run(`INSERT INTO prints (${columns.join(', ')}) SELECT ${values} FROM prints WHERE id = '${ID}'`);
		const kept = await takedownPrint(h.env, ID, null);
		expect(kept.screenshot).toBe('shared');
		expect(h.shots.objects.has(`${IMAGE}.png`)).toBe(true);
		expect(h.sqlite.query(`SELECT count(*) AS n FROM removal_blocks WHERE kind = 'image'`).get()).toEqual({ n: 0 });
	});

	test('a retry without the box still takes down a shared screenshot an earlier run blocked', async () => {
		const h = await setup();
		const columns = (h.sqlite.query('PRAGMA table_info(prints)').all() as { name: string }[]).map((c) => c.name);
		const values = columns.map((c) => (c === 'id' ? `'-Twin'` : c)).join(', ');
		h.sqlite.run(`INSERT INTO prints (${columns.join(', ')}) SELECT ${values} FROM prints WHERE id = '${ID}'`);
		// The first run, about the image, blocked it and stopped before the screenshot's files.
		const failing = {
			...h.env,
			RENDERS: { ...h.renders, list: async () => Promise.reject(new Error('cut short')) } as unknown as R2Bucket
		};
		await expect(takedownPrint(failing, ID, null, { screenshotToo: true })).rejects.toThrow('cut short');
		expect(h.shots.objects.has(`${IMAGE}.png`)).toBe(true);
		const again = await takedownPrint(h.env, ID, null);
		expect(again.screenshot).toBe('removed');
		expect(h.shots.objects.has(`${IMAGE}.png`)).toBe(false);
	});
});

describe('purgePrintData', () => {
	test('deletes without blocking, and a later ingest brings the print back and clears the tombstone', async () => {
		const h = await setup();
		await purgePrintData(h.env, ID, { kind: 'gone' });
		expect(await isPrintRemoved(h.db, ID)).toBe(false);
		expect(h.count('SELECT count(*) AS n FROM print_tombstones WHERE print_id = ?')).toBe(1);
		expect((await h.ingest()).status).toBe('analysed');
		expect(h.count('SELECT count(*) AS n FROM prints WHERE id = ?')).toBe(1);
		expect(h.count('SELECT count(*) AS n FROM print_tombstones WHERE print_id = ?')).toBe(0);
	});

	test('a takedown tombstone stays a takedown', async () => {
		const h = await setup();
		await takedownPrint(h.env, ID, null);
		await purgePrintData(h.env, ID, { kind: 'gone' });
		expect(h.sqlite.query('SELECT kind FROM print_tombstones WHERE print_id = ?').get(ID)).toEqual({ kind: 'takedown' });
	});

	test('a gone print’s screenshot is left alone, and never recorded as removed on request', async () => {
		const h = await setup();
		const r = await purgePrintData(h.env, ID, { kind: 'gone' });
		expect(r.screenshot).toBe('kept');
		expect(h.shots.objects.has(`${IMAGE}.png`)).toBe(true);
		expect(h.sqlite.query('SELECT count(*) AS n FROM screenshot_removals').get()).toEqual({ n: 0 });
	});

	test('with screenshotToo a gone print’s screenshot goes, still not in screenshot_removals', async () => {
		const h = await setup();
		const r = await purgePrintData(h.env, ID, { kind: 'gone', screenshotToo: true });
		expect(r.screenshot).toBe('removed');
		expect(h.shots.objects.has(`${IMAGE}.png`)).toBe(false);
		expect(h.sqlite.query('SELECT state FROM screenshots WHERE image_id = ?').get(IMAGE)).toEqual({ state: 'removed' });
		expect(h.sqlite.query('SELECT count(*) AS n FROM screenshot_removals').get()).toEqual({ n: 0 });
	});
});

describe('deletePrefix', () => {
	test('pages through more than 1,000 keys and keeps what it is told to', async () => {
		const b = bucket(new Map(Array.from({ length: 2345 }, (_, i) => [`p/${i}`, ''] as [string, string])));
		expect(await deletePrefix(b, 'p/', (k) => k === 'p/7')).toBe(2344);
		expect([...b.objects.keys()]).toEqual(['p/7']);
	});
});

describe('a big book', () => {
	test('a 700-page book’s takedown blocks every page hash in a handful of statements', async () => {
		const h = await setup();
		// 700 pages of 50 solar panels each, every page spaced differently: 700 page hashes of 50 entities.
		const pages = Array.from({ length: 700 }, (_, i) => ({
			index: i,
			blueprint: {
				item: 'blueprint',
				version: 562949954076672,
				entities: Array.from({ length: 50 }, (_, j) => ({
					entity_number: j + 1,
					name: 'solar-panel',
					position: { x: j * (3 + i) + 1.5, y: 1.5 }
				}))
			}
		}));
		const BIG = '-ZZbigBookOf700Pages';
		const record = JSON.parse(FIXTURE) as Record<string, unknown>;
		record.blueprintString = await encodeExchangeString({ blueprint_book: { item: 'blueprint-book', blueprints: pages } });
		const layer = Layer.mergeAll(
			PrintRepositoryD1(h.db),
			Layer.succeed(RawStore, {
				put: (k, v) => Effect.sync(() => void h.raw.objects.set(k, v)),
				get: (k) => Effect.succeed(h.raw.objects.get(k) ?? null),
				delete: (k) => Effect.sync(() => void h.raw.objects.delete(k))
			})
		);
		expect((await Effect.runPromise(Effect.provide(ingestText(BIG, JSON.stringify(record), 'test'), layer))).status).toBe('analysed');
		// Count what reaches D1.
		const statements: number[] = [];
		const counted = new Proxy(h.db, {
			get: (target, key) =>
				key === 'batch'
					? (stmts: D1PreparedStatement[]) => (statements.push(stmts.length), target.batch(stmts))
					: (target[key as keyof D1Database] as (...a: unknown[]) => unknown).bind(target)
		});
		await takedownPrint({ ...h.env, DB: counted }, BIG, null);
		const blocks = h.sqlite.query(`SELECT count(*) AS n FROM removal_blocks WHERE print_id = ? AND kind = 'sha256'`).get(BIG) as {
			n: number;
		};
		// Every page and the whole book.
		expect(blocks.n).toBe(701);
		// The first batch: the blocks (701 sha256 + print + source, 500 a statement) and the tombstone.
		expect(statements[0]).toBe(3);
		expect(Math.max(...statements)).toBeLessThan(20);
	});
});
