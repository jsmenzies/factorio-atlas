import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { fixtureRecord } from '#lib/server/fixtures.js';
import { addRecord } from './add-record';
import { admitRecord } from './admit';
import { d1FromSqlite } from './d1-sqlite';
import { pipelineLayer } from './layers';
import { ingestRecord } from './pipeline';
import { fromFactorioprints, fromPipelineText, rawKeyFor, type SourceRecord } from './source-record';

/** A polled site's changed records (`update`), on the real migrations and gate; the records are made up, the strings mirror fixtures. */

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const FP_ID = '-KYpTULTDIvDOsJfgjeS';
const FP_TEXT = await fixtureRecord(FP_ID);
const STRING = (JSON.parse(FP_TEXT) as { blueprintString: string }).blueprintString;
const BOOK = (JSON.parse(await fixtureRecord('-KnQ865j-qQ21WoUPbd3')) as { blueprintString: string }).blueprintString;

const setup = () => {
	const sqlite = new Database(':memory:');
	for (const f of readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.sort())
		sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
	const DB = d1FromSqlite(sqlite);
	const objects = new Map<string, string>();
	const RAW = {
		get: async (k: string) =>
			objects.has(k) ? { text: async () => objects.get(k)!, json: async () => JSON.parse(objects.get(k)!) } : null,
		head: async (k: string) => (objects.has(k) ? {} : null),
		put: async (k: string, v: string) => void objects.set(k, v),
		delete: async (keys: string | string[]) => {
			for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
		},
		list: async () => ({ objects: [], truncated: false })
	} as unknown as R2Bucket;
	const env = { DB, RAW, MIRROR_BASE_URL: 'https://mirror.test', FIREBASE_BASE_URL: 'https://firebase.test' } as unknown as Env;
	const one = <T>(sql: string, ...args: (string | number)[]) => sqlite.query(sql).get(...args) as T | null;
	return { DB, RAW, objects, env, one, b: { DB, RAW } };
};

const codex = (siteId: string, over: Partial<SourceRecord> = {}): SourceRecord => ({
	site: 'codex',
	siteId,
	url: `https://factoriocodex.com/blueprints/${siteId}`,
	title: 'Science',
	description: null,
	author: { site: 'codex', id: '7', name: 'Someone' },
	blueprintString: BOOK,
	image: null,
	uploadedAt: Date.UTC(2025, 0, 1),
	updatedAt: Date.UTC(2025, 0, 1),
	favorites: null,
	sourceHints: [],
	...over
});

describe('addRecord with update (a polled site changed the record)', () => {
	test('its own print: ingested again, the change shown', async () => {
		const s = setup();
		expect(await addRecord(s.b, codex('5'))).toMatchObject({ status: 'new', printId: 'codex-5' });
		expect(await addRecord(s.b, codex('5', { title: 'Science v2' }))).toMatchObject({ status: 'already', printId: 'codex-5' });
		expect(s.one('SELECT title FROM prints WHERE id = ?', 'codex-5')).toEqual({ title: 'Science' });
		// Planning never writes, update or not.
		expect(await addRecord(s.b, codex('5', { title: 'Science v2' }), { update: true, plan: true })).toMatchObject({
			status: 'already',
			planned: true
		});
		expect(await addRecord(s.b, codex('5', { title: 'Science v2', updatedAt: 2 }), { update: true })).toEqual({
			status: 'already',
			printId: 'codex-5',
			updated: true,
			planned: false
		});
		expect(s.one('SELECT title FROM prints WHERE id = ?', 'codex-5')).toEqual({ title: 'Science v2' });
	});

	test('a source of another print (posted later): archived again, the print still shows the first upload', async () => {
		const s = setup();
		const fp = fromFactorioprints(FP_ID, FP_TEXT);
		const admitted = await admitRecord(s.DB, fp);
		if (admitted.status !== 'new') throw new Error(admitted.status);
		await Effect.runPromise(Effect.provide(ingestRecord(fp, { ...admitted, printId: FP_ID }), pipelineLayer(s.env)));
		const copy = codex('9', { blueprintString: STRING, uploadedAt: Date.UTC(2026, 0, 1) });
		expect(await addRecord(s.b, copy, { update: true })).toMatchObject({ status: 'joins', printId: FP_ID, shown: false });
		const edited = { ...copy, title: 'Renamed on codex', updatedAt: Date.UTC(2026, 1, 1) };
		expect(await addRecord(s.b, edited, { update: true })).toMatchObject({ status: 'already', printId: FP_ID, updated: true });
		expect(fromPipelineText(s.objects.get(rawKeyFor('codex', '9'))!)).toMatchObject({ title: 'Renamed on codex' });
		expect(s.one('SELECT source FROM prints WHERE id = ?', FP_ID)).toEqual({ source: 'factorioprints' });
	});

	test('a copy edited into something else leaves the print it copied: detached, added afresh, the print keeps its identity', async () => {
		const s = setup();
		const fp = fromFactorioprints(FP_ID, FP_TEXT);
		const admitted = await admitRecord(s.DB, fp);
		if (admitted.status !== 'new') throw new Error(admitted.status);
		await Effect.runPromise(Effect.provide(ingestRecord(fp, { ...admitted, printId: FP_ID }), pipelineLayer(s.env)));
		const hash = () => s.one(`SELECT sha256 FROM print_fingerprints WHERE print_id = ? AND kind = 'print' AND current = 1`, FP_ID);
		const before = hash();
		const copy = codex('9', { blueprintString: STRING, uploadedAt: Date.UTC(2026, 0, 1) });
		expect(await addRecord(s.b, copy, { update: true })).toMatchObject({ status: 'joins', printId: FP_ID });
		const docSites = () =>
			(
				(JSON.parse(s.objects.get(`analysis/${FP_ID}.json`) ?? '{}') as { print?: { sources?: { site: string }[] } }).print?.sources ?? []
			).map((x) => x.site);
		expect(docSites()).toContain('codex');
		// Edited on codex into a different blueprint (a book).
		const edited = { ...copy, blueprintString: BOOK, updatedAt: Date.UTC(2026, 1, 1) };
		expect(await addRecord(s.b, edited, { update: true })).toMatchObject({ status: 'new', printId: 'codex-9', detachedFrom: FP_ID });
		expect(hash()).toEqual(before);
		expect(s.one('SELECT print_id FROM print_sources WHERE site = ? AND site_id = ?', 'codex', '9')).toEqual({ print_id: 'codex-9' });
		expect(docSites()).not.toContain('codex');
		// A later real copy still joins the print it copies, and the book doesn't.
		expect(await addRecord(s.b, codex('10', { blueprintString: STRING, uploadedAt: Date.UTC(2026, 2, 1) }))).toMatchObject({
			status: 'joins',
			printId: FP_ID
		});
		expect(await addRecord(s.b, codex('11', { blueprintString: BOOK, uploadedAt: Date.UTC(2026, 2, 1) }))).toMatchObject({
			status: 'joins',
			printId: 'codex-9'
		});
	});

	const printHash = (s: ReturnType<typeof setup>, id: string) =>
		s.one<{ sha256: string }>(`SELECT sha256 FROM print_fingerprints WHERE print_id = ? AND kind = 'print' AND current = 1`, id)?.sha256;
	const other = (site: 'fprints' | 'factoriobin', siteId: string, over: Partial<SourceRecord> = {}): SourceRecord => ({
		...codex(siteId, over),
		site,
		url: `https://example.com/${site}/${siteId}`,
		author: { site, id: '8', name: 'Other' }
	});

	test('its own print (codex-N), another site shown there: the edit keeps codex-N, the other source moves to a print of its own', async () => {
		const s = setup();
		expect(await addRecord(s.b, codex('5', { blueprintString: STRING }), { update: true })).toMatchObject({
			status: 'new',
			printId: 'codex-5'
		});
		// An older post of the same blueprint on another site joins it, and, posted first, is shown.
		const older = other('fprints', 'abc', { blueprintString: STRING, uploadedAt: Date.UTC(2024, 0, 1) });
		expect(await addRecord(s.b, older)).toMatchObject({ status: 'joins', printId: 'codex-5', shown: true });
		expect(s.one('SELECT source FROM prints WHERE id = ?', 'codex-5')).toEqual({ source: 'fprints' });
		const before = printHash(s, 'codex-5');
		const r = await addRecord(s.b, codex('5', { blueprintString: BOOK, updatedAt: Date.UTC(2026, 1, 1) }), { update: true });
		expect(r).toMatchObject({
			status: 'already',
			printId: 'codex-5',
			updated: true,
			moved: [{ site: 'fprints', siteId: 'abc', printId: 'fprints-abc' }]
		});
		expect(r.detachedFrom).toBeUndefined();
		// codex-5 shows the edited record; the fprints post is its own print, with the content it had.
		expect(s.one('SELECT source FROM prints WHERE id = ?', 'codex-5')).toEqual({ source: 'codex' });
		expect(printHash(s, 'codex-5') === before).toBe(false);
		expect(printHash(s, 'fprints-abc')).toBe(before);
		expect(s.one('SELECT print_id FROM print_sources WHERE site = ? AND site_id = ?', 'fprints', 'abc')).toEqual({
			print_id: 'fprints-abc'
		});
		expect(s.one('SELECT print_id FROM print_sources WHERE site = ? AND site_id = ?', 'codex', '5')).toEqual({ print_id: 'codex-5' });
		// The record codex-5's own source archived is the edited one (what the record store hands the render step).
		expect(fromPipelineText(s.objects.get(rawKeyFor('codex', '5'))!)?.blueprintString).toBe(BOOK);
		// Again: nothing more to split.
		expect(await addRecord(s.b, codex('5', { blueprintString: BOOK, updatedAt: Date.UTC(2026, 1, 1) }), { update: true })).toMatchObject({
			status: 'already',
			printId: 'codex-5'
		});
	});

	test('its own print, shown there: an edit keeps it, and a later copy of the old content moves off', async () => {
		const s = setup();
		await addRecord(s.b, codex('6', { blueprintString: STRING, uploadedAt: Date.UTC(2024, 0, 1) }));
		expect(await addRecord(s.b, other('factoriobin', 'Later123', { blueprintString: STRING }))).toMatchObject({
			status: 'joins',
			printId: 'codex-6',
			shown: false
		});
		const r = await addRecord(s.b, codex('6', { blueprintString: BOOK, uploadedAt: Date.UTC(2024, 0, 1), updatedAt: 9 }), { update: true });
		expect(r).toMatchObject({ status: 'already', printId: 'codex-6', moved: [{ printId: 'fbin-Later123' }] });
		expect(s.one('SELECT source FROM prints WHERE id = ?', 'fbin-Later123')).toEqual({ source: 'factoriobin' });
	});

	test("another source's print, shown there: the edited record leaves, the next source is credited", async () => {
		const s = setup();
		const fp = fromFactorioprints(FP_ID, FP_TEXT);
		const admitted = await admitRecord(s.DB, fp);
		if (admitted.status !== 'new') throw new Error(admitted.status);
		await Effect.runPromise(Effect.provide(ingestRecord(fp, { ...admitted, printId: FP_ID }), pipelineLayer(s.env)));
		// A codex copy posted before factorioprints' record: shown on the factorioprints print.
		expect(await addRecord(s.b, codex('7', { blueprintString: STRING, uploadedAt: Date.UTC(2010, 0, 1) }))).toMatchObject({
			status: 'joins',
			printId: FP_ID,
			shown: true
		});
		expect(s.one('SELECT source FROM prints WHERE id = ?', FP_ID)).toEqual({ source: 'codex' });
		const before = printHash(s, FP_ID);
		const r = await addRecord(s.b, codex('7', { blueprintString: BOOK, uploadedAt: Date.UTC(2010, 0, 1), updatedAt: 9 }), { update: true });
		expect(r).toMatchObject({ status: 'new', printId: 'codex-7', detachedFrom: FP_ID });
		expect(s.one('SELECT source FROM prints WHERE id = ?', FP_ID)).toEqual({ source: 'factorioprints' });
		expect(printHash(s, FP_ID)).toBe(before);
		expect(s.one('SELECT COUNT(*) AS n FROM print_sources WHERE print_id = ?', FP_ID)).toEqual({ n: 1 });
	});

	test('its own print, an earlier source that cannot move (no archived record): failed, the print keeps its identity', async () => {
		const s = setup();
		await addRecord(s.b, codex('8', { blueprintString: STRING }), { update: true });
		const older = other('fprints', 'old', { blueprintString: STRING, uploadedAt: Date.UTC(2024, 0, 1) });
		expect(await addRecord(s.b, older)).toMatchObject({ status: 'joins', printId: 'codex-8', shown: true });
		s.objects.delete(rawKeyFor('fprints', 'old'));
		const before = printHash(s, 'codex-8');
		const r = await addRecord(s.b, codex('8', { blueprintString: BOOK, updatedAt: 9 }), { update: true });
		expect(r).toMatchObject({ status: 'failed', moved: [{ site: 'fprints', siteId: 'old', printId: null, reason: 'no archived record' }] });
		expect(printHash(s, 'codex-8')).toBe(before);
		expect(s.one('SELECT source FROM prints WHERE id = ?', 'codex-8')).toEqual({ source: 'fprints' });
	});

	test('leaving a print it was shown on with no archived record to hand it to: failed, nothing written', async () => {
		const s = setup();
		const fp = fromFactorioprints(FP_ID, FP_TEXT);
		const admitted = await admitRecord(s.DB, fp);
		if (admitted.status !== 'new') throw new Error(admitted.status);
		await Effect.runPromise(Effect.provide(ingestRecord(fp, { ...admitted, printId: FP_ID }), pipelineLayer(s.env)));
		await addRecord(s.b, codex('9', { blueprintString: STRING, uploadedAt: Date.UTC(2010, 0, 1) }));
		s.objects.delete(rawKeyFor('factorioprints', FP_ID));
		const r = await addRecord(s.b, codex('9', { blueprintString: BOOK, uploadedAt: Date.UTC(2010, 0, 1), updatedAt: 9 }), { update: true });
		expect(r).toMatchObject({ status: 'failed' });
		expect(s.one('SELECT print_id, gone_at FROM print_sources WHERE site = ? AND site_id = ?', 'codex', '9')).toEqual({
			print_id: FP_ID,
			gone_at: null
		});
		expect(s.one('SELECT source FROM prints WHERE id = ?', FP_ID)).toEqual({ source: 'codex' });
	});
});
