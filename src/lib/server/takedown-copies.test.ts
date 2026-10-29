import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { fixtureRecord } from '#lib/server/fixtures.js';
import { d1FromSqlite } from './pipeline/d1-sqlite';
import { ingestText } from './pipeline/pipeline';
import { RawStoreR2 } from './pipeline/raw-store';
import { PrintRepositoryD1 } from './pipeline/repository';
import { isPrintRemoved } from './removal-blocks';
import { applyTakedown, createRemovalRequest, decide, reportQueue } from './reports';
import type { TakedownEnv } from './takedown';

const ROOT = join(import.meta.dirname, '../../..');
/** All the Belts, by its author; the same author's re-post; someone else's; and an unrelated print. */
const ID = '-KYpTULTDIvDOsJfgjeS';
const FIXTURE = await fixtureRecord(ID);
const SAME = '-ZZsameAuthorRepost0';
const OTHER = '-ZZotherAuthorRepost';
const UNRELATED = '-KnQ865j-qQ21WoUPbd3';
const BOOK = await fixtureRecord(UNRELATED);

const repost = (days: number, author?: string) => {
	const r = JSON.parse(FIXTURE) as Record<string, unknown>;
	r.createdDate = (r.createdDate as number) + days * 86_400_000;
	if (author) r.author = { userId: author };
	return JSON.stringify(r);
};

/** Just enough of R2: get, put, delete, list by prefix; `fail` makes a listing under a prefix throw once. */
const bucket = () => {
	const objects = new Map<string, string>();
	const failing = new Set<string>();
	const b = {
		get: async (key: string) => (objects.has(key) ? { text: async () => objects.get(key)! } : null),
		put: async (key: string, body: string) => void objects.set(key, body),
		delete: async (keys: string | string[]) => {
			for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
		},
		list: async ({ prefix = '' }: R2ListOptions = {}) => {
			if (failing.delete(prefix)) throw new Error(`R2 list failed for ${prefix}`);
			return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
		}
	} as unknown as R2Bucket;
	return Object.assign(b, { objects, failing });
};

const setup = async () => {
	const sqlite = new Database(':memory:');
	for (const f of readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.sort()) {
		sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
	}
	const db = d1FromSqlite(sqlite);
	const raw = bucket();
	const renders = bucket();
	const shots = bucket();
	const layer = Layer.mergeAll(PrintRepositoryD1(db), RawStoreR2(raw));
	const ingest = (id: string, text: string) => Effect.runPromise(Effect.provide(ingestText(id, text, 'test'), layer));
	await ingest(ID, FIXTURE);
	await ingest(SAME, repost(1));
	await ingest(OTHER, repost(2, 'someoneElse000000000000000001'));
	await ingest(UNRELATED, BOOK);
	for (const id of [ID, SAME, OTHER]) renders.objects.set(`${id}/index.json`, '{}');
	const env: TakedownEnv = { DB: db, RAW: raw, RENDERS: renders, SCREENSHOTS: shots, RENDERS_URL: '', SCREENSHOTS_URL: '' };
	const folds = () => sqlite.query('SELECT id, duplicate_of, identical_to FROM prints ORDER BY id').all();
	const tombstones = () => sqlite.query('SELECT print_id, kind FROM print_tombstones ORDER BY print_id').all();
	const doc = (id: string) => JSON.parse(raw.objects.get(`analysis/${id}.json`) ?? 'null') as { print: Record<string, unknown> } | null;
	await createRemovalRequest(db, { printId: ID, reason: 'author', details: null, contact: null, reporterUserId: null });
	return { sqlite, db, raw, renders, env, folds, tombstones, doc };
};

describe('a removal with identical copies', () => {
	test('the queue lists them, the same author’s first and marked; others aren’t copies', async () => {
		const h = await setup();
		expect(h.folds()).toEqual([
			{ id: ID, duplicate_of: null, identical_to: null },
			{ id: UNRELATED, duplicate_of: null, identical_to: null },
			{ id: OTHER, duplicate_of: null, identical_to: ID },
			{ id: SAME, duplicate_of: ID, identical_to: null }
		]);
		const { open } = await reportQueue(h.db);
		expect(open[0].copies.map((c) => [c.id, c.sameAuthor])).toEqual([
			[SAME, true],
			[OTHER, false]
		]);
	});

	test('approve with the same author’s ticked: both go, each blocked and tombstoned; the other stays, on its own', async () => {
		const h = await setup();
		// A form naming a print that isn't a copy takes nothing else down.
		const r = await decide(h.env, { subjectKind: 'print', subjectId: ID, approve: true, note: null, by: 'dev', copies: [SAME, UNRELATED] });
		expect(r.takedown?.copies).toEqual([SAME]);
		expect(r.takedown?.purged).toBe(true);
		for (const id of [ID, SAME]) expect(await isPrintRemoved(h.db, id)).toBe(true);
		for (const id of [OTHER, UNRELATED]) expect(await isPrintRemoved(h.db, id)).toBe(false);
		expect(h.tombstones()).toEqual([
			{ print_id: ID, kind: 'takedown' },
			{ print_id: SAME, kind: 'takedown' }
		]);
		expect(h.folds()).toEqual([
			{ id: UNRELATED, duplicate_of: null, identical_to: null },
			{ id: OTHER, duplicate_of: null, identical_to: null }
		]);
		expect(h.doc(OTHER)?.print.identical_to).toBeUndefined();
		expect(h.doc(SAME)).toBeNull();
		expect([...h.renders.objects.keys()]).toEqual([`${OTHER}/index.json`]);
		// Each print has its own blocks, the content's hash among the first's.
		const blocks = h.sqlite.query('SELECT print_id, kind FROM removal_blocks ORDER BY print_id, kind').all() as {
			print_id: string;
			kind: string;
		}[];
		expect(blocks.filter((b) => b.print_id === SAME).map((b) => b.kind)).toEqual(['print', 'source']);
		expect(blocks.filter((b) => b.print_id === ID).map((b) => b.kind)).toEqual(['print', 'sha256', 'source']);
		expect(h.sqlite.query('SELECT copies, applied_at IS NOT NULL AS applied FROM reports').get()).toEqual({
			copies: JSON.stringify([SAME]),
			applied: 1
		});
	});

	test('a run that stops part-way through the copies is finished by running it again', async () => {
		const h = await setup();
		h.renders.failing.add(`${SAME}/`);
		await expect(
			decide(h.env, { subjectKind: 'print', subjectId: ID, approve: true, note: null, by: 'dev', copies: [SAME] })
		).rejects.toThrow(`R2 list failed for ${SAME}/`);
		// The print is down; the copy is blocked and tombstoned but not finished; the request isn't applied.
		expect(await isPrintRemoved(h.db, ID)).toBe(true);
		expect(await isPrintRemoved(h.db, SAME)).toBe(true);
		const row = h.sqlite.query('SELECT applied_at, apply_error FROM reports').get() as { applied_at: number | null; apply_error: string };
		expect(row.applied_at).toBeNull();
		expect(row.apply_error).toContain('R2 list failed');
		// Run again (the admin's "Run takedown again"): it reads the chosen copies from the report.
		const again = await applyTakedown(h.env, ID, false);
		expect(again.copies).toEqual([SAME]);
		expect(again.purged).toBe(true);
		expect(h.folds()).toEqual([
			{ id: UNRELATED, duplicate_of: null, identical_to: null },
			{ id: OTHER, duplicate_of: null, identical_to: null }
		]);
		expect([...h.renders.objects.keys()]).toEqual([`${OTHER}/index.json`]);
		expect(h.sqlite.query('SELECT applied_at IS NOT NULL AS applied, apply_error FROM reports').get()).toEqual({
			applied: 1,
			apply_error: null
		});
	});

	test('nothing ticked: only the print goes; its copies stay up and stand on their own', async () => {
		const h = await setup();
		await decide(h.env, { subjectKind: 'print', subjectId: ID, approve: true, note: null, by: 'dev' });
		expect(h.folds()).toEqual([
			{ id: UNRELATED, duplicate_of: null, identical_to: null },
			// The same author's re-post is now the earliest; the other print is identical to it.
			{ id: OTHER, duplicate_of: null, identical_to: SAME },
			{ id: SAME, duplicate_of: null, identical_to: null }
		]);
		expect(h.doc(SAME)?.print.copy_of).toBeUndefined();
		expect(h.doc(OTHER)?.print.identical_to).toEqual({ id: SAME });
	});
});
