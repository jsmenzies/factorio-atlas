import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureRecord } from '#lib/server/fixtures.js';
import { nameTaken, NAME_HOLD_DAYS, renameAccount, signInAccount } from '../auth/users';
import { analysisKey } from '../pipeline/print-doc';
import { d1FromSqlite } from '../pipeline/d1-sqlite';
import { admitRecord } from '../pipeline/admit';
import { pipelineLayer } from '../pipeline/layers';
import { ingestRecord } from '../pipeline/pipeline';
import { fromFactorioprints, fromPipelineText, toPipelineText } from '../pipeline/source-record';
import { takedownPrint } from '../takedown';
import { Effect } from 'effect';
import { admitUpload, ingestDue, workerGate } from './gate';
import {
	admitProcessing,
	createUpload,
	deleteUpload,
	editUpload,
	imageKey,
	processingUploads,
	readRecord,
	recordKey,
	refreshUploadNames,
	sha256Hex,
	siteIdOf,
	type UploadInput
} from './uploads';

/** The real gate end to end: dedup's admitRecord and ingestRecord, removals' purge, on the real migrations. */

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const ID = '-KYpTULTDIvDOsJfgjeS';
const FIXTURE = await fixtureRecord(ID);
const STRING = (JSON.parse(FIXTURE) as { blueprintString: string }).blueprintString;
const TITLE = (JSON.parse(FIXTURE) as { title: string }).title;
const BOOK = (JSON.parse(await fixtureRecord('-KnQ865j-qQ21WoUPbd3')) as { blueprintString: string }).blueprintString;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** Enough of R2 for the pipeline, uploads and the purge. */
const bucket = () => {
	const objects = new Map<string, string | Uint8Array>();
	const body = (v: string | Uint8Array) => ({
		text: async () => (typeof v === 'string' ? v : new TextDecoder().decode(v)),
		json: async () => JSON.parse(typeof v === 'string' ? v : new TextDecoder().decode(v)),
		arrayBuffer: async () => (typeof v === 'string' ? new TextEncoder().encode(v) : v).buffer
	});
	return Object.assign(
		{
			get: async (k: string) => (objects.has(k) ? body(objects.get(k)!) : null),
			head: async (k: string) => (objects.has(k) ? {} : null),
			put: async (k: string, v: string | Uint8Array) => void objects.set(k, v),
			delete: async (keys: string | string[]) => {
				for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
			},
			list: async ({ prefix = '', cursor, limit = 1000 }: R2ListOptions = {}) => {
				const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
				const start = cursor ? Number(cursor) : 0;
				const truncated = start + limit < keys.length;
				return {
					objects: keys.slice(start, start + limit).map((key) => ({ key })),
					truncated,
					cursor: truncated ? String(start + limit) : undefined
				};
			}
		} as unknown as R2Bucket,
		{ objects }
	);
};

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const setup = async () => {
	const sqlite = new Database(':memory:');
	for (const f of readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.sort())
		sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
	const db = d1FromSqlite(sqlite);
	const [RAW, RENDERS, SCREENSHOTS] = [bucket(), bucket(), bucket()];
	const env = {
		DB: db,
		RAW,
		RENDERS,
		SCREENSHOTS,
		RENDERS_URL: '',
		SCREENSHOTS_URL: '',
		MIRROR_BASE_URL: 'https://mirror.test',
		FIREBASE_BASE_URL: 'https://firebase.test'
	} as unknown as Env;
	const gate = workerGate(env);
	const deps = (now = 2_000_000_000_000) => ({ db, raw: RAW, gate, origin: 'https://example.com', now });
	const account = async (name: string) => {
		const r = await signInAccount(db, 'dev', { subject: name.toLowerCase(), name });
		if (!r.ok) throw new Error('banned');
		return r.account;
	};
	const one = <T>(sql: string, ...args: (string | number)[]) => sqlite.query(sql).get(...args) as T | null;
	return { sqlite, db, env, RAW, gate, deps, account, one };
};

const input = (over: Partial<UploadInput> = {}): UploadInput => ({
	title: 'My belts',
	description: 'Every belt.',
	blueprintString: STRING,
	image: null,
	...over
});

describe('fromPipelineText', () => {
	test('turns toPipelineText back, and refuses anything else', () => {
		const record = {
			site: 'upload' as const,
			siteId: 'abcdefghij',
			url: 'https://example.com/prints/up-abcdefghij',
			title: 'T',
			description: 'D',
			author: { site: 'upload' as const, id: 'u1', name: 'Ada' },
			blueprintString: STRING,
			image: null,
			uploadedAt: 5,
			updatedAt: 6,
			favorites: 0,
			tags: [],
			sourceHints: []
		};
		expect(fromPipelineText(toPipelineText(record))).toEqual(record);
		expect(fromPipelineText(FIXTURE)).toBeNull();
		expect(fromPipelineText('not json')).toBeNull();
	});
});

describe('uploads through the real gate', () => {
	test('an upload goes live as its own print, with its source and its row in one go', async () => {
		const s = await setup();
		const ada = await s.account('Ada');
		const r = await createUpload(s.deps(), ada, input());
		expect(r).toMatchObject({ ok: true, state: 'live' });
		const printId = r.ok ? r.printId : '';
		expect(s.one<{ title: string }>('SELECT title FROM prints WHERE id = ?', printId)).toEqual({ title: 'My belts' });
		expect(s.one('SELECT site, site_id FROM print_sources WHERE print_id = ?', printId)).toEqual({
			site: 'upload',
			site_id: siteIdOf(printId)
		});
		expect(s.one('SELECT state FROM uploads WHERE print_id = ?', printId)).toEqual({ state: 'live' });
		// The pipeline archived its text at the upload's key, and uploads read it back.
		expect(await readRecord(s.RAW, printId)).toMatchObject({ site: 'upload', title: 'My belts', blueprintString: STRING });
		expect(s.RAW.objects.has(`analysis/${printId}.json`)).toBe(true);
	});

	test('the same blueprint again is refused with a link, as the uploader’s own or someone else’s', async () => {
		const s = await setup();
		const [ada, bob] = [await s.account('Ada'), await s.account('Bob')];
		const first = await createUpload(s.deps(), ada, input());
		const printId = first.ok ? first.printId : '';
		expect(await createUpload(s.deps(), ada, input({ title: 'Again' }))).toMatchObject({
			ok: false,
			status: 409,
			problem: 'You’ve already uploaded this blueprint.',
			existing: { printId, own: true }
		});
		expect(await createUpload(s.deps(), bob, input())).toMatchObject({
			ok: false,
			existing: { printId, own: false },
			problem: 'This blueprint is already on Blueprint Atlas.'
		});
		// Nothing of the refused uploads stays.
		expect(s.one<{ n: number }>('SELECT count(*) AS n FROM uploads')).toEqual({ n: 1 });
	});

	test('a print from factorioprints refuses its copy', async () => {
		const s = await setup();
		const record = fromFactorioprints(ID, FIXTURE);
		const admitted = await admitRecord(s.db, record);
		if (admitted.status !== 'new') throw new Error(admitted.status);
		await Effect.runPromise(Effect.provide(ingestRecord(record, { ...admitted, printId: ID }), pipelineLayer(s.env)));
		expect(await createUpload(s.deps(), await s.account('Ada'), input())).toMatchObject({
			ok: false,
			existing: { printId: ID, own: false }
		});
	});

	test('an edit re-ingests the print at its URL', async () => {
		const s = await setup();
		const ada = await s.account('Ada');
		const r = await createUpload(s.deps(), ada, input());
		const printId = r.ok ? r.printId : '';
		expect(await editUpload(s.deps(), ada, printId, input({ title: 'Renamed', blueprintString: '' }))).toMatchObject({
			ok: true,
			state: 'live'
		});
		expect(s.one('SELECT title FROM prints WHERE id = ?', printId)).toEqual({ title: 'Renamed' });
		expect(s.one('SELECT title FROM uploads WHERE print_id = ?', printId)).toEqual({ title: 'Renamed' });
	});

	test('an owner’s delete purges the print, leaves a gone tombstone and blocks nothing', async () => {
		const s = await setup();
		const ada = await s.account('Ada');
		const r = await createUpload(s.deps(), ada, input({ blueprintString: BOOK }));
		const printId = r.ok ? r.printId : '';
		expect(await deleteUpload(s.deps(), ada.id, printId)).toBe(true);
		expect(s.one('SELECT 1 AS hit FROM prints WHERE id = ?', printId)).toBeNull();
		expect(s.one('SELECT kind FROM print_tombstones WHERE print_id = ?', printId)).toEqual({ kind: 'gone' });
		expect(s.one<{ n: number }>('SELECT count(*) AS n FROM removal_blocks')).toEqual({ n: 0 });
		expect(s.one('SELECT 1 AS hit FROM uploads WHERE print_id = ?', printId)).toBeNull();
		expect(s.RAW.objects.has(recordKey(siteIdOf(printId)))).toBe(false);
		// Not blocked: it can be uploaded again.
		expect(await createUpload(s.deps(), ada, input({ blueprintString: BOOK }))).toMatchObject({ ok: true, state: 'live' });
	});

	test('a takedown of an upload takes its rows and pending screenshot, keeps its blocks and the day’s counts', async () => {
		const s = await setup();
		const ada = await s.account('Ada');
		const r = await createUpload(s.deps(), ada, input({ image: PNG }));
		const printId = r.ok ? r.printId : '';
		const image = (await sha256Hex(PNG)).slice(0, 16);
		const quota = s.one('SELECT uploads, images FROM upload_quota WHERE user_id = ?', ada.id);
		await takedownPrint(s.env, printId, null);
		expect(s.one('SELECT 1 AS hit FROM prints WHERE id = ?', printId)).toBeNull();
		expect(s.one('SELECT 1 AS hit FROM uploads WHERE print_id = ?', printId)).toBeNull();
		expect(s.one('SELECT 1 AS hit FROM upload_images WHERE id = ?', image)).toBeNull();
		expect(s.RAW.objects.has(imageKey(image, 'png'))).toBe(false);
		expect(s.RAW.objects.has(recordKey(siteIdOf(printId)))).toBe(false);
		expect(s.one('SELECT kind FROM print_tombstones WHERE print_id = ?', printId)).toEqual({ kind: 'takedown' });
		expect(s.one('SELECT 1 AS hit FROM removal_blocks WHERE kind = ? AND value = ?', 'print', printId)).toEqual({ hit: 1 });
		expect(s.one('SELECT uploads, images FROM upload_quota WHERE user_id = ?', ada.id)).toEqual(quota);
		// The same string again, from anyone: refused.
		expect(await createUpload(s.deps(), await s.account('Bob'), input())).toMatchObject({
			ok: false,
			status: 409,
			problem: 'This blueprint can’t be uploaded.'
		});
	});

	test('when a factorioprints copy joined later, the owner’s delete hands the print over to it at the same URL', async () => {
		const s = await setup();
		const ada = await s.account('Ada');
		// Posted long before the factorioprints record, so the upload is credited.
		const r = await createUpload(s.deps(1_000), ada, input());
		const printId = r.ok ? r.printId : '';
		const record = fromFactorioprints(ID, FIXTURE);
		const admitted = await admitRecord(s.db, record);
		expect(admitted).toMatchObject({ status: 'existing', printId, via: 'exact' });
		if (admitted.status !== 'existing') throw new Error(admitted.status);
		await Effect.runPromise(Effect.provide(ingestRecord(record, admitted), pipelineLayer(s.env)));
		expect(s.one('SELECT title FROM prints WHERE id = ?', printId)).toEqual({ title: 'My belts' });

		// The hand-over fetches the factorioprints record from the mirror.
		globalThis.fetch = (async (url: string | URL | Request) =>
			String(url).startsWith('https://mirror.test/') ? new Response(FIXTURE) : new Response('', { status: 404 })) as typeof fetch;
		expect(await deleteUpload(s.deps(), ada.id, printId)).toBe(true);
		expect(s.one('SELECT title FROM prints WHERE id = ?', printId)).toEqual({ title: TITLE });
		expect(s.one('SELECT 1 AS hit FROM uploads WHERE print_id = ?', printId)).toBeNull();
		expect(s.one('SELECT gone_at IS NOT NULL AS gone FROM print_sources WHERE site = ? AND print_id = ?', 'upload', printId)).toEqual({
			gone: 1
		});
	});

	test('if the hand-over can’t re-ingest the next source, the print is purged and the next update owes an ingest', async () => {
		const s = await setup();
		const ada = await s.account('Ada');
		const r = await createUpload(s.deps(1_000), ada, input());
		const printId = r.ok ? r.printId : '';
		const record = fromFactorioprints(ID, FIXTURE);
		const admitted = await admitRecord(s.db, record);
		if (admitted.status !== 'existing') throw new Error(admitted.status);
		await Effect.runPromise(Effect.provide(ingestRecord(record, admitted), pipelineLayer(s.env)));
		expect(await ingestDue(s.db)).toBeNull();
		// The mirror and Firebase are unreachable.
		globalThis.fetch = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
		expect(await deleteUpload(s.deps(), ada.id, printId)).toBe(true);
		expect(s.one('SELECT 1 AS hit FROM prints WHERE id = ?', printId)).toBeNull();
		expect(await ingestDue(s.db)).not.toBeNull();
	});

	test('a rename reaches the account’s uploads; until it has, nobody else can take the old name', async () => {
		const s = await setup();
		const ada = await s.account('Ada');
		const grace = await s.account('Grace');
		const r = await createUpload(s.deps(), ada, input());
		const printId = r.ok ? r.printId : '';
		const doc = async () => JSON.parse(await (await s.RAW.get(analysisKey(printId)))!.text()).print.author_name;
		expect([await doc(), s.one('SELECT author_name FROM prints WHERE id = ?', printId)]).toEqual(['Ada', { author_name: 'Ada' }]);

		expect(await renameAccount(s.db, ada.id, 'Ada Lovelace')).toEqual({ ok: true, name: 'Ada Lovelace' });
		// Out of time before any upload: the old name is still shown, so it stays taken past the 30-day hold.
		expect(await refreshUploadNames({ db: s.db, raw: s.RAW }, ada.id, { budgetMs: 0 })).toEqual({ done: 0, left: 1 });
		const later = Date.now() + (NAME_HOLD_DAYS + 1) * 86_400_000;
		expect(await nameTaken(s.db, 'ada', grace.id, later)).toBe(true);

		// The sync's run (every account) puts it right: record, document, card row, search row.
		expect(await refreshUploadNames({ db: s.db, raw: s.RAW }, null)).toEqual({ done: 1, left: 0 });
		expect(await doc()).toBe('Ada Lovelace');
		expect((await readRecord(s.RAW, printId))?.author?.name).toBe('Ada Lovelace');
		expect(s.one('SELECT author_name FROM prints WHERE id = ?', printId)).toEqual({ author_name: 'Ada Lovelace' });
		expect(s.one('SELECT author FROM print_search WHERE print_id = ?', printId)).toEqual({ author: 'Ada Lovelace' });
		expect(s.one('SELECT shown_name FROM uploads WHERE print_id = ?', printId)).toEqual({ shown_name: 'Ada Lovelace' });
		expect(s.one(`SELECT 1 AS hit FROM meta WHERE key = 'sync_version'`)).toEqual({ hit: 1 });
		expect(await nameTaken(s.db, 'ada', grace.id, later)).toBe(false);
		// And an edit after it keeps the new name.
		await editUpload(s.deps(), { ...ada, name: 'Ada Lovelace' }, printId, input({ title: 'Edited', blueprintString: '' }));
		expect(await doc()).toBe('Ada Lovelace');
	});

	describe('processing uploads, admitted by the sync (scripts/uploads.ts)', () => {
		/** The Worker's gate with caps small enough that every upload waits, as an over-cap one would. */
		const tinyCaps = (s: Awaited<ReturnType<typeof setup>>) => ({
			...s.deps(),
			gate: { ...s.gate, admit: (r, p, e) => admitUpload(s.env, r, p, e, { maxStringBytes: 10, maxEntitiesAndTiles: 10 }) } as typeof s.gate
		});
		const bunGate = (s: Awaited<ReturnType<typeof setup>>) => ({
			db: s.db,
			raw: s.RAW,
			gate: { admit: admitUpload.bind(null, s.env) },
			now: 2_000_000_100_000
		});

		test('over the caps it waits; the sync admits it as the Worker would have', async () => {
			const s = await setup();
			const r = await createUpload(tinyCaps(s), await s.account('Ada'), input());
			expect(r).toMatchObject({ ok: true, state: 'processing' });
			const printId = r.ok ? r.printId : '';
			expect(s.one('SELECT 1 AS hit FROM prints WHERE id = ?', printId)).toBeNull();
			expect((await processingUploads(s.db)).map((u) => u.print_id)).toEqual([printId]);
			expect(await admitProcessing(bunGate(s), printId)).toEqual({ outcome: 'admitted' });
			expect(s.one('SELECT state, too_big, live_at FROM uploads WHERE print_id = ?', printId)).toEqual({
				state: 'live',
				too_big: null,
				live_at: 2_000_000_100_000
			});
			expect(s.one('SELECT title FROM prints WHERE id = ?', printId)).toEqual({ title: 'My belts' });
			expect(await processingUploads(s.db)).toEqual([]);
		});

		test('one whose blueprint went live meanwhile is refused as a duplicate, linking that print', async () => {
			const s = await setup();
			const waiting = await createUpload(tinyCaps(s), await s.account('Ada'), input());
			const live = await createUpload(s.deps(), await s.account('Bob'), input({ title: 'Bob’s belts' }));
			const [waitingId, liveId] = [waiting.ok ? waiting.printId : '', live.ok ? live.printId : ''];
			expect(live).toMatchObject({ ok: true, state: 'live' });
			expect(await admitProcessing(bunGate(s), waitingId)).toEqual({ outcome: 'duplicate', printId: liveId });
			expect(s.one('SELECT state, refused_reason, refused_print_id FROM uploads WHERE print_id = ?', waitingId)).toEqual({
				state: 'refused',
				refused_reason: 'duplicate',
				refused_print_id: liveId
			});
			expect(s.one('SELECT 1 AS hit FROM prints WHERE id = ?', waitingId)).toBeNull();
		});
	});
});
