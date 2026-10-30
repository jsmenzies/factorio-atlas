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
});
