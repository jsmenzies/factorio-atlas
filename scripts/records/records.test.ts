import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPrintId } from '#lib/print-id.js';
import { d1FromSqlite } from '#lib/server/pipeline/d1-sqlite.js';
import { toPipelineText, type SourceRecord } from '#lib/server/pipeline/source-record.js';
import { RENDER_FILE } from '#lib/viewer/game-render.js';
import { diskPages, uploadedPages } from '../render/flags.js';
import { batchCandidates } from '../render/scope.js';
import { blueprintPages, cloneSource, decode, storeSource, withStore } from '../render/source.js';
import { planPull, pullSite, type Listed, type StoreAdapter } from './pull';
import { putRecord, readIndex, recordFile, recordsDir, storeFileOf, storePrintIds } from './store';
import { uploadRev, uploadsStoreAdapter } from './uploads';

const ROOT = join(import.meta.dirname, '..', '..');
/** A small 2.0.72 blueprint: one wooden chest. */
const STRING =
	'0eJxNjEEKwjAUBe/y1lFabcT8rccoIo1+MJD8lCZVS8jdxerC1TCzmALrZx4nJxlU4DIH0F9T8INlD8LpzunjD56SiwLSh53pjNHHdm9M0ymwZJcdJ1BfvrJcZA6WJ1CrIENgEJ4x3lg2199ujMnl9VfwAjVbrbCsrPVc6xuLpTPq';

const upload = (siteId: string, over: Partial<SourceRecord> = {}): SourceRecord => ({
	site: 'upload',
	siteId,
	url: `https://example.com/prints/up-${siteId}`,
	title: `Upload ${siteId}`,
	description: null,
	author: { site: 'upload', id: 'u1', name: 'Someone' },
	blueprintString: STRING,
	image: null,
	uploadedAt: 1,
	updatedAt: 1,
	favorites: 0,
	tags: [],
	sourceHints: [],
	...over
});

/** A site in memory: `records` by site id, each with its revision. */
const fakeSite = (records: Map<string, { rev: string; record: SourceRecord | null }>, fail = new Set<string>()) => {
	const fetched: string[] = [];
	const adapter: StoreAdapter = {
		site: 'upload',
		list: async () => [...records].map(([siteId, r]) => ({ siteId, rev: r.rev })),
		fetch: async (siteId) => {
			fetched.push(siteId);
			if (fail.has(siteId)) throw new Error('boom');
			return records.get(siteId)?.record ?? null;
		}
	};
	return { adapter, fetched };
};

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'records-test-'));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('store', () => {
	test('RECORDS_DIR, else ~/data/factorio-records, never the repo', () => {
		expect(recordsDir('/repo', '/x/y')).toBe('/x/y');
		expect(recordsDir('/repo', 'rel')).toBe('/repo/rel');
		expect(recordsDir('/repo', '').endsWith('/data/factorio-records')).toBe(true);
		expect(recordsDir('/repo', undefined).startsWith('/repo')).toBe(false);
	});

	test('files by site and site id; only ids that make a print id', () => {
		expect(recordFile('/s', 'upload', 'AbCdE12345')).toBe('/s/upload/AbCdE12345.json');
		expect(storeFileOf('/s', 'up-AbCdE12345')).toBe('/s/upload/AbCdE12345.json');
		expect(storeFileOf('/s', 'fbin-LYMz5ZJT')).toBe('/s/factoriobin/LYMz5ZJT.json');
		expect(storeFileOf('/s', '-LI0gc-a-2_VLWR-tx1d')).toBeNull();
		expect(() => recordFile('/s', 'upload', '../../etc/x')).toThrow();
		expect(() => recordFile('/s', 'upload', 'short')).toThrow();
	});

	test('a record is rewritten only when its text changes', async () => {
		const r = upload('AbCdE12345');
		expect(await putRecord(dir, r)).toBe(true);
		const file = recordFile(dir, 'upload', 'AbCdE12345');
		await utimes(file, 1000, 1000);
		expect(await putRecord(dir, { ...r })).toBe(false);
		expect(Math.round((await import('node:fs')).statSync(file).mtimeMs)).toBe(1_000_000);
		expect(await putRecord(dir, { ...r, title: 'New title' })).toBe(true);
		expect(JSON.parse(await readFile(file, 'utf8')).title).toBe('New title');
		await expect(putRecord(dir, { ...r, site: 'factorioprints' })).rejects.toThrow();
	});

	test('print ids of every site, skipping the index and strays', async () => {
		await putRecord(dir, upload('BbBbB22222'));
		await putRecord(dir, upload('AaAaA11111'));
		mkdirSync(join(dir, 'upload'), { recursive: true });
		writeFileSync(join(dir, 'upload', 'not-an-id.json'), '{}');
		writeFileSync(join(dir, 'upload', 'notes.txt'), '');
		await putRecord(dir, { ...upload('x'), site: 'factoriobin', siteId: 'LYMz5ZJT' });
		expect(await storePrintIds(dir)).toEqual(['up-AaAaA11111', 'up-BbBbB22222', 'fbin-LYMz5ZJT']);
		expect(await storePrintIds(join(dir, 'missing'))).toEqual([]);
	});
});

describe('pull', () => {
	test('planPull: new, changed, unchanged and gone', () => {
		const listing: Listed[] = [
			{ siteId: 'a', rev: '1' },
			{ siteId: 'b', rev: '2' },
			{ siteId: 'c', rev: '1' },
			{ siteId: 'a', rev: '9' }
		];
		const index = {
			v: 1 as const,
			records: {
				b: { rev: '1', firstSeen: 1, fetchedAt: 1 },
				c: { rev: '1', firstSeen: 1, fetchedAt: 1 },
				d: { rev: '1', firstSeen: 1, fetchedAt: 1 }
			}
		};
		const p = planPull(listing, index);
		expect(p.fetch.map((l) => l.siteId)).toEqual(['a', 'b']);
		expect(p).toMatchObject({ added: 1, changed: 1, unchanged: 1, gone: ['d'], listed: 3 });
	});

	test('fetches only new and changed records; removes gone ones; keeps first-seen; retries failures', async () => {
		const site = new Map<string, { rev: string; record: SourceRecord | null }>([
			['AaAaA11111', { rev: '1:A', record: upload('AaAaA11111') }],
			['BbBbB22222', { rev: '1:A', record: upload('BbBbB22222') }]
		]);
		const fail = new Set(['BbBbB22222']);
		let t = 100;
		const s = fakeSite(site, fail);
		let c = await pullSite(dir, s.adapter, { now: () => ++t });
		expect(c).toMatchObject({ listed: 2, added: 1, failed: 1, removed: 0 });
		expect(await storePrintIds(dir)).toEqual(['up-AaAaA11111']);

		fail.clear();
		s.fetched.length = 0;
		c = await pullSite(dir, s.adapter, { now: () => ++t });
		expect(s.fetched).toEqual(['BbBbB22222']);
		expect(c).toMatchObject({ added: 1, unchanged: 1, failed: 0 });

		// Nothing changed: nothing fetched.
		s.fetched.length = 0;
		c = await pullSite(dir, s.adapter);
		expect(s.fetched).toEqual([]);
		expect(c).toMatchObject({ unchanged: 2, added: 0, changed: 0 });

		// An edit (new rev, new text), a rename with the same text, a deletion, and one gone after the listing.
		const firstSeen = (await readIndex(dir, 'upload')).records.AaAaA11111.firstSeen;
		site.set('AaAaA11111', { rev: '2:A', record: upload('AaAaA11111', { title: 'Edited' }) });
		site.set('BbBbB22222', { rev: '1:B', record: upload('BbBbB22222') });
		site.set('CcCcC33333', { rev: '1:A', record: null });
		site.delete('DdDdD44444');
		c = await pullSite(dir, s.adapter, { now: () => ++t });
		expect(c).toMatchObject({ changed: 2, rewritten: 1, vanished: 1 });
		const index = await readIndex(dir, 'upload');
		expect(index.records.AaAaA11111).toMatchObject({ rev: '2:A', firstSeen });
		expect(index.records.CcCcC33333).toBeUndefined();

		site.delete('BbBbB22222');
		c = await pullSite(dir, s.adapter);
		expect(c).toMatchObject({ removed: 1 });
		expect(await storePrintIds(dir)).toEqual(['up-AaAaA11111']);
	});

	test('a dry run counts and writes nothing', async () => {
		const s = fakeSite(new Map([['AaAaA11111', { rev: '1', record: upload('AaAaA11111') }]]));
		const c = await pullSite(dir, s.adapter, { dryRun: true });
		expect(c).toMatchObject({ added: 1, left: 1 });
		expect(s.fetched).toEqual([]);
		expect(await storePrintIds(dir)).toEqual([]);
	});

	test('a record that names another site or id is refused', async () => {
		const s = fakeSite(new Map([['AaAaA11111', { rev: '1', record: upload('BbBbB22222') }]]));
		expect(await pullSite(dir, s.adapter)).toMatchObject({ failed: 1, added: 0 });
	});
});

describe('uploads adapter', () => {
	const setup = () => {
		const sqlite = new Database(':memory:');
		for (const f of readdirSync(join(ROOT, 'migrations'))
			.filter((f) => f.endsWith('.sql'))
			.sort())
			sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
		sqlite.run(`INSERT INTO users (id, name, created_at) VALUES ('u1', 'Someone', 1)`);
		const add = (siteId: string, state: string, updated = 5, name = 'Someone') =>
			sqlite
				.query(
					`INSERT INTO uploads (print_id, user_id, state, title, string_bytes, shown_name, created_at, updated_at)
					VALUES (?, 'u1', ?, 't', 1, ?, 1, ?)`
				)
				.run(`up-${siteId}`, state, name, updated);
		const objects = new Map<string, string>();
		const raw = { get: async (k: string) => (objects.has(k) ? { text: async () => objects.get(k)! } : null) } as unknown as R2Bucket;
		return { sqlite, add, objects, adapter: uploadsStoreAdapter({ DB: d1FromSqlite(sqlite), RAW: raw }) };
	};

	test('lists live uploads without a tombstone, revised by edit time and shown name', async () => {
		const h = setup();
		h.add('AaAaA11111', 'live', 7, 'Old name');
		h.add('BbBbB22222', 'processing');
		h.add('CcCcC33333', 'refused');
		h.add('DdDdD44444', 'live');
		h.sqlite.run(`INSERT INTO print_tombstones (print_id, kind, at) VALUES ('up-DdDdD44444', 'takedown', 1)`);
		expect(await h.adapter.list()).toEqual([{ siteId: 'AaAaA11111', rev: uploadRev({ updated_at: 7, shown_name: 'Old name' }) }]);
	});

	test('reads the record from RAW as a SourceRecord', async () => {
		const h = setup();
		const r = upload('AaAaA11111', { description: 'Hello', updatedAt: 7 });
		h.objects.set('upload/AaAaA11111.json', toPipelineText(r));
		h.objects.set('upload/BbBbB22222.json', '{"title":"not a source record"}');
		expect(await h.adapter.fetch('AaAaA11111')).toMatchObject({
			site: 'upload',
			siteId: 'AaAaA11111',
			title: r.title,
			description: 'Hello',
			blueprintString: STRING,
			updatedAt: 7
		});
		expect(await h.adapter.fetch('CcCcC33333')).toBeNull();
		await expect(h.adapter.fetch('BbBbB22222')).rejects.toThrow();
	});
});

describe('an upload through the render pipeline', () => {
	test('the source resolves up- ids from the store and the rest from the clone', async () => {
		const clone = join(dir, 'clone');
		const store = join(dir, 'store');
		mkdirSync(join(clone, '-li'), { recursive: true });
		writeFileSync(join(clone, '-li', '-LI0gc-a-2_VLWR-tx1d.json'), JSON.stringify({ title: 'Mirror print', blueprintString: STRING }));
		await putRecord(store, upload('AaAaA11111'));
		const source = withStore(cloneSource(clone), store);
		// The store's prints first: a --next batch takes them before the mirror's.
		expect(await source.ids()).toEqual(['up-AaAaA11111', '-LI0gc-a-2_VLWR-tx1d']);
		expect((await source.read('up-AaAaA11111'))?.title).toBe('Upload AaAaA11111');
		expect((await source.read('-LI0gc-a-2_VLWR-tx1d'))?.title).toBe('Mirror print');
		expect(source.file('up-AaAaA11111')).toBe(join(store, 'upload', 'AaAaA11111.json'));
		expect(await source.read('up-ZzZzZ99999')).toBeNull();
		expect(await source.stamp('up-ZzZzZ99999')).toBeNull();
		// No store: the clone itself, label and all.
		expect(withStore(cloneSource(clone), null).label).toBe(cloneSource(clone).label);
		expect(await storeSource(store).ids()).toEqual(['up-AaAaA11111']);
	});

	test('picked by --next when new and when edited, not when unchanged; pages decode; flags and files take its id', async () => {
		const store = join(dir, 'store');
		const id = 'up-AaAaA11111';
		await putRecord(store, upload('AaAaA11111'));
		const source = storeSource(store);
		const state = (seen: Map<string, string | null>, stamps: Map<string, string | null>) =>
			batchCandidates([id], { rows: new Map(), seen, stamps, uploads: null, top: [], retryFailed: false }).candidates;
		const stamp = await source.stamp(id);
		expect(stamp).not.toBeNull();
		expect(state(new Map(), new Map([[id, stamp]]))).toEqual([id]);
		// Looked at with this stamp, then pulled again with no change: no work.
		await putRecord(store, upload('AaAaA11111'));
		expect(await source.stamp(id)).toBe(stamp);
		expect(state(new Map([[id, stamp]]), new Map([[id, await source.stamp(id)]]))).toEqual([]);
		// An owner's edit: a new stamp, looked at again (the run then redraws only pages whose input key changed).
		await putRecord(store, upload('AaAaA11111', { title: 'Edited', updatedAt: 2 }));
		expect(state(new Map([[id, stamp]]), new Map([[id, await source.stamp(id)]]))).toEqual([id]);

		const record = await source.read(id);
		const pages = [...blueprintPages(await decode(record!.blueprintString))];
		expect(pages.map((p) => [p.path, p.version])).toEqual([['', [2, 0, 72, 0]]]);

		// Its renders and their uploads count for render:flags like any print's.
		const renders = join(dir, 'renders');
		mkdirSync(join(renders, id), { recursive: true });
		writeFileSync(
			join(renders, id, 'index.json'),
			JSON.stringify({ v: 2, cover: '', pages: { '': { stamp: 'aaaaaaaaaa', overview: 'root.aaaaaaaaaa.avif' } } })
		);
		expect([...(await diskPages(renders))]).toEqual([[id, 1]]);
		const done = { print_id: id, path: '', status: 'done' as const, stamp: 'aaaaaaaaaa', finished_at: 1 };
		const up = {
			target: 'local' as const,
			print_id: id,
			path: '',
			stamp: 'aaaaaaaaaa',
			rendered_at: null,
			stale: 0,
			files: 1,
			bytes: 1,
			uploaded_at: 2,
			error: null,
			failed_at: null
		};
		expect([...uploadedPages([done], [up])]).toEqual([[id, 1]]);
		// The site's routes take the id, and its files are render files.
		expect(isPrintId(id)).toBe(true);
		for (const f of ['index.json', 'thumbs.json', 'root.aaaaaaaaaa.avif', 'root.json', 'root.page.json', 'root.aaaaaaaaaa.t320.avif'])
			expect(RENDER_FILE.test(f)).toBe(true);
	});
});
