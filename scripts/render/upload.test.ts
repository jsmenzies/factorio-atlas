import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RenderIndex, RenderSidecar } from '#lib/viewer/game-render.js';
import { mergeArgs, parseArgs, resolveArgs, resumeArgs, defaultArgs, UsageError } from './args.js';
import { parseListXml, StoreError, withRetries, type RenderStore } from './store.js';
import { createUploader, DELETE_GRACE_MS, planPrint, rateWindow, type UploadJob, type UploaderDb, type UploadRow } from './upload.js';

const ID = '-Test1';

/** A bucket in memory that logs every call, with optional failures. */
function fakeStore() {
	const objects = new Map<string, { body: Uint8Array; type: string; cacheControl: string }>();
	const calls: string[] = [];
	let failNext: ((op: string, key: string) => Error | null) | null = null;
	const store: RenderStore & { objects: typeof objects; calls: string[]; fail(f: typeof failNext): void } = {
		label: 'fake',
		objects,
		calls,
		fail: (f) => {
			failNext = f;
		},
		async put(key, body, type, cacheControl) {
			const err = failNext?.('put', key);
			if (err) throw err;
			calls.push(`PUT ${key}`);
			objects.set(key, { body, type, cacheControl });
		},
		async delete(key) {
			const err = failNext?.('delete', key);
			if (err) throw err;
			calls.push(`DELETE ${key}`);
			objects.delete(key);
		},
		async list(prefix) {
			calls.push(`LIST ${prefix}`);
			return [...objects.keys()].filter((k) => k.startsWith(prefix));
		}
	};
	return store;
}

function fakeDb(jobs: UploadJob[]) {
	const uploads = new Map<string, UploadRow>();
	/** render_deletes, by key (one target in these tests). */
	const deletes = new Map<
		string,
		{ target: string; key: string; print_id: string; not_before: number; reason: string; queued_at: number }
	>();
	const k = (t: string, id: string, p: string) => `${t}\n${id}\n${p}`;
	const db: UploaderDb & { jobs: UploadJob[]; uploads: typeof uploads; deletes: typeof deletes; log: string[] } = {
		jobs,
		uploads,
		deletes,
		log: [],
		scheduleDeletes: async (target, rows, notBefore, queuedAt) => {
			for (const r of rows) if (!deletes.has(r.key)) deletes.set(r.key, { target, ...r, not_before: notBefore, queued_at: queuedAt });
		},
		pendingDeletesOf: async (t, id) => [...deletes.values()].filter((d) => d.target === t && d.print_id === id).map((d) => d.key),
		dueDeletes: async (t, at, after, limit) =>
			[...deletes.values()]
				.filter((d) => d.target === t && d.not_before <= at && d.key > after)
				.sort((a, b) => (a.key < b.key ? -1 : 1))
				.slice(0, limit)
				.map(({ key, print_id, reason }) => ({ key, print_id, reason })),
		dropDeletes: async (_t, keys) => {
			for (const key of keys) deletes.delete(key);
		},
		countDeletes: async (t) => {
			const due = [...deletes.values()].filter((d) => d.target === t).map((d) => d.not_before);
			return { n: due.length, next: due.length ? Math.min(...due) : null };
		},
		jobsOf: async (id) => db.jobs.filter((j) => j.print_id === id),
		uploadsOf: async (t, id) => [...uploads.values()].filter((u) => u.target === t && u.print_id === id),
		recordUpload: async (row) => {
			db.log.push(`record ${row.path}`);
			uploads.set(k(row.target, row.print_id, row.path), row);
		},
		recordFailure: async (t, id, path, error, at) => {
			const old = uploads.get(k(t, id, path));
			uploads.set(k(t, id, path), {
				...(old ?? {
					target: t,
					print_id: id,
					path,
					stamp: null,
					rendered_at: null,
					stale: 0,
					files: null,
					bytes: null,
					uploaded_at: null
				}),
				error,
				failed_at: at
			});
		},
		forgetUploads: async (t, id, paths) => {
			for (const p of paths) uploads.delete(k(t, id, p));
		}
	};
	return db;
}

let out: string;
beforeEach(async () => {
	out = await mkdtemp(join(tmpdir(), 'upload-test-'));
});
afterEach(async () => {
	await rm(out, { recursive: true, force: true });
});

const base = (path: string) => path || 'root';

/** Write a rendered page to disk: tiles, overview, page data, sidecar. */
async function renderPage(path: string, stamp: string, tiles: string[], renderedAt = `2026-10-20T00:00:0${stamp.length % 10}Z`) {
	const dir = join(out, ID);
	await mkdir(join(dir, 't'), { recursive: true });
	if (path.includes('/')) await mkdir(join(dir, path.split('/').slice(0, -1).join('/')), { recursive: true });
	for (const t of tiles) if (t) await writeFile(join(dir, 't', `${t}.avif`), `tile ${t}`);
	await writeFile(join(dir, `${base(path)}.${stamp}.avif`), `overview ${path} ${stamp}`);
	await writeFile(join(dir, `${base(path)}.page.json`), JSON.stringify({ v: 1, stamp, page: {} }));
	const sc = {
		v: 2,
		id: ID,
		path,
		inputKey: stamp.padEnd(64, '0'),
		stamp,
		renderedAt,
		levels: [{ ppt: 32, width: 1024, height: 512, cols: 2, rows: 1, tiles }],
		overview: { file: `${base(path)}.${stamp}.avif`, width: 10, height: 10, ppt: 8 }
	} as unknown as RenderSidecar;
	await writeFile(join(dir, `${base(path)}.json`), JSON.stringify(sc));
	return { path, stamp, renderedAt };
}

const job = (path: string, stamp: string, status: UploadJob['status'] = 'done', finished_at = 1): UploadJob => ({
	print_id: ID,
	path,
	status,
	stamp,
	finished_at
});

const H = (n: number) => n.toString(16).padStart(16, '0');
const A = 'aaaaaaaaaa';

function uploader(store: RenderStore, db: UploaderDb, extra: Partial<Parameters<typeof createUploader>[0]> = {}) {
	let t = 1000;
	return createUploader({
		target: 'local',
		store,
		db,
		outDir: out,
		concurrency: 4,
		log: () => {},
		retry: { sleep: async () => {} },
		retryDelayMs: () => 1,
		maxRounds: 2,
		now: () => ++t,
		...extra
	});
}

const index = (store: ReturnType<typeof fakeStore>) => {
	const o = store.objects.get(`${ID}/index.json`);
	return o ? (JSON.parse(new TextDecoder().decode(o.body)) as RenderIndex) : null;
};

describe('uploader', () => {
	test('a page goes up tiles and overview first, then page data, the sidecar, the index, and only then its row', async () => {
		await renderPage('', 'aaaaaaaaaa', [H(1), H(2)]);
		const store = fakeStore();
		const db = fakeDb([job('', 'aaaaaaaaaa')]);
		const u = uploader(store, db);
		u.schedule(ID, 1);
		await u.drain();
		const puts = store.calls.filter((c) => c.startsWith('PUT'));
		expect(puts.slice(0, 3).sort()).toEqual([`PUT ${ID}/root.${A}.avif`, `PUT ${ID}/t/${H(1)}.avif`, `PUT ${ID}/t/${H(2)}.avif`]);
		expect(puts.slice(3)).toEqual([`PUT ${ID}/root.page.json`, `PUT ${ID}/root.json`, `PUT ${ID}/index.json`]);
		expect(db.log).toEqual(['record ']);
		expect(index(store)).toEqual({ v: 2, cover: '', pages: { '': { stamp: A, overview: `root.${A}.avif` } } });
		expect(store.objects.get(`${ID}/t/${H(1)}.avif`)?.type).toBe('image/avif');
		expect(store.objects.get(`${ID}/t/${H(1)}.avif`)?.cacheControl).toBe('public, max-age=31536000, immutable');
		expect(store.objects.get(`${ID}/root.${A}.avif`)?.cacheControl).toBe('public, max-age=31536000, immutable');
		expect(store.objects.get(`${ID}/index.json`)?.cacheControl).toBe('public, max-age=60');
		expect(store.objects.get(`${ID}/root.json`)?.cacheControl).toBe('public, max-age=300');
		expect(store.objects.get(`${ID}/root.page.json`)?.cacheControl).toBe('public, max-age=300');
		expect(store.objects.get(`${ID}/root.json`)?.type).toBe('application/json');
		expect(u.stats).toMatchObject({ pages: 1, files: 5 });
		expect(u.pending).toBe(0);
		// Speed counts the same objects as stats (not the index rewrite).
		const r = u.rates();
		expect(r.files).toBeGreaterThan(0);
		expect(r.bytes! / r.files!).toBeCloseTo(u.stats.bytes / u.stats.files);
		expect(r.pages).toBeGreaterThan(0);
	});

	test('a print the stage deleted is never uploaded; one deleted mid-run is caught by the re-check; a failed check uploads nothing', async () => {
		await renderPage('', 'aaaaaaaaaa', [H(1)]);
		const store = fakeStore();
		const db = fakeDb([job('', 'aaaaaaaaaa')]);
		const asked: string[] = [];
		let deleted = true;
		const u = uploader(store, db, {
			removed: async (id) => {
				asked.push(id);
				return deleted;
			}
		});
		u.schedule(ID, 1);
		await u.drain();
		expect(asked).toEqual([ID]);
		expect(store.calls.filter((c) => c.startsWith('PUT'))).toEqual([]);
		expect(db.uploads.size).toBe(0);
		expect(u.pending).toBe(0);

		// The check fails (the stage unreachable): nothing goes up, and the sync counts as failed.
		const failing = uploader(store, db, {
			removed: async () => {
				throw new Error('stage unreachable');
			}
		});
		failing.schedule(ID, 1);
		await failing.drain();
		expect(store.calls.filter((c) => c.startsWith('PUT'))).toEqual([]);
		expect(failing.stats.lastError).toContain('stage unreachable');

		// Not deleted: it goes up as usual.
		deleted = false;
		const ok = uploader(store, db, { removed: async () => deleted });
		ok.schedule(ID, 1);
		await ok.drain();
		expect(store.calls.filter((c) => c.startsWith('PUT'))).toContain(`PUT ${ID}/index.json`);
	});

	test('settled() waits for a print to sync, resolving at once when nothing is queued or after a stop', async () => {
		await renderPage('', 'aaaaaaaaaa', [H(1)]);
		const store = fakeStore();
		const u = uploader(store, fakeDb([job('', 'aaaaaaaaaa')]));
		await u.settled('other');
		u.schedule(ID, 1);
		await u.settled(ID);
		// Its index went up before settled() resolved.
		expect(index(store)?.pages['']?.stamp).toBe(A);
		u.schedule(ID, 1);
		u.stop();
		await u.settled(ID);
		await u.drain();
	});

	test('tiles shared by pages go up once, and the index lists only pages whose files are up', async () => {
		await renderPage('1', 'bbbbbbbbbb', [H(1), H(2)]);
		await renderPage('2', 'cccccccccc', [H(2), H(3)]);
		await renderPage('3', 'dddddddddd', [H(4), '']);
		await rm(join(out, ID, 't', `${H(4)}.avif`));
		const store = fakeStore();
		const db = fakeDb([job('1', 'bbbbbbbbbb'), job('2', 'cccccccccc'), job('3', 'dddddddddd')]);
		const u = uploader(store, db);
		u.schedule(ID, 3);
		await u.drain();
		const tilePuts = store.calls.filter((c) => c.includes('/t/'));
		expect(tilePuts.length).toBe(3);
		expect(Object.keys(index(store)!.pages)).toEqual(['1', '2']);
		expect(store.objects.has(`${ID}/3.json`)).toBe(false);
		expect(db.uploads.get(`local\n${ID}\n3`)?.stamp).toBeNull();
		expect(db.uploads.get(`local\n${ID}\n3`)?.error).toContain('ENOENT');
		expect(u.failing).toBe(1);
		expect(u.pending).toBe(1);
	});

	test('a restart sends nothing that made it up: finished pages not at all, an interrupted page only its unsent files', async () => {
		await renderPage('1', 'bbbbbbbbbb', [H(1), H(2)]);
		await renderPage('2', 'cccccccccc', [H(3), H(4)]);
		const store = fakeStore();
		const db = fakeDb([job('1', 'bbbbbbbbbb'), job('2', 'cccccccccc')]);
		// The first run dies while page 2 goes up: after one of its tiles.
		let tiles2 = 0;
		store.fail((op, key) => (op === 'put' && key.endsWith(`${H(4)}.avif`) && tiles2++ === 0 ? new StoreError('killed', false) : null));
		// One request at a time, so tile 3 is always sent before tile 4 fails (in parallel, which read finishes first varies).
		const first = uploader(store, db, { maxRounds: 1, concurrency: 1 });
		first.schedule(ID, 2);
		await first.drain();
		expect(Object.keys(index(store)!.pages)).toEqual(['1']);
		store.fail(null);
		store.calls.length = 0;

		const second = uploader(store, db);
		second.schedule(ID);
		await second.drain();
		const puts = store.calls.filter((c) => c.startsWith('PUT'));
		expect(puts.slice(0, 2).sort()).toEqual([`PUT ${ID}/2.cccccccccc.avif`, `PUT ${ID}/t/${H(4)}.avif`]);
		expect(puts.slice(2)).toEqual([`PUT ${ID}/2.page.json`, `PUT ${ID}/2.json`, `PUT ${ID}/index.json`]);
		expect(Object.keys(index(store)!.pages)).toEqual(['1', '2']);

		store.calls.length = 0;
		const third = uploader(store, db);
		third.schedule(ID);
		await third.drain();
		expect(store.calls).toEqual([]);
	});

	test('a re-rendered page replaces its files; unused tiles are scheduled once every uploaded page is the version on disk', async () => {
		await renderPage('1', 'bbbbbbbbbb', [H(1), H(2)]);
		await renderPage('2', 'cccccccccc', [H(3), H(9)]);
		const store = fakeStore();
		const db = fakeDb([job('1', 'bbbbbbbbbb'), job('2', 'cccccccccc')]);
		const u = uploader(store, db);
		u.schedule(ID, 2);
		await u.drain();

		// Page 1 re-rendered (new tiles); page 2 re-rendered on disk but not marked done yet: the bucket's
		// version of page 2 is unknown on disk, so nothing may be swept.
		await renderPage('1', 'eeeeeeeeee', [H(5), H(2)]);
		await renderPage('2', 'ffffffffff', [H(6), H(9)]);
		db.jobs = [job('1', 'eeeeeeeeee', 'done', 5000), job('2', 'cccccccccc', 'rendering')];
		const v = uploader(store, db);
		v.schedule(ID);
		await v.drain();
		expect(index(store)!.pages).toEqual({
			'1': { stamp: 'eeeeeeeeee', overview: '1.eeeeeeeeee.avif' },
			'2': { stamp: 'cccccccccc', overview: '2.cccccccccc.avif' }
		});
		// The old overview of page 1 is scheduled, not deleted; tiles aren't even scheduled (unsafe to sweep yet).
		expect(store.calls.filter((c) => c.startsWith('DELETE'))).toEqual([]);
		expect([...db.deletes.keys()]).toEqual([`${ID}/1.bbbbbbbbbb.avif`]);
		expect(store.objects.has(`${ID}/1.bbbbbbbbbb.avif`)).toBe(true);
		// What the --flags step's page-cache bump goes by.
		expect(v.stats).toMatchObject({ replaced: 1, removed: 0 });
		expect(u.stats).toMatchObject({ replaced: 0, removed: 0 });

		// Page 2 done: now every uploaded page is on disk as uploaded, and tiles 1 and 3 are scheduled.
		db.jobs = [job('1', 'eeeeeeeeee', 'done', 5000), job('2', 'ffffffffff', 'done', 5000)];
		store.calls.length = 0;
		const w = uploader(store, db, { now: () => 10_000 });
		w.schedule(ID);
		await w.drain();
		expect(store.calls.filter((c) => c.startsWith('DELETE'))).toEqual([]);
		expect([...db.deletes.keys()].sort()).toEqual(
			[`${ID}/1.bbbbbbbbbb.avif`, `${ID}/2.cccccccccc.avif`, `${ID}/t/${H(1)}.avif`, `${ID}/t/${H(3)}.avif`].sort()
		);
		expect(db.deletes.get(`${ID}/t/${H(1)}.avif`)).toMatchObject({ reason: 'unused', not_before: 10_000 + DELETE_GRACE_MS });
		expect(db.deletes.get(`${ID}/2.cccccccccc.avif`)?.reason).toBe('replaced');

		// After the grace period they go.
		store.calls.length = 0;
		const x = uploader(store, db, { now: () => 10_000 + DELETE_GRACE_MS });
		await x.processDeletes();
		expect(store.calls.filter((c) => c.startsWith('DELETE')).sort()).toEqual(
			[
				`DELETE ${ID}/1.bbbbbbbbbb.avif`,
				`DELETE ${ID}/2.cccccccccc.avif`,
				`DELETE ${ID}/t/${H(1)}.avif`,
				`DELETE ${ID}/t/${H(3)}.avif`
			].sort()
		);
		expect(db.deletes.size).toBe(0);
		expect(x.stats.deleted).toBe(4);
		expect(x.deletesPending).toBe(0);
		expect([...store.objects.keys()].filter((k) => k.includes('/t/')).sort()).toEqual(
			[H(2), H(5), H(6), H(9)].map((h) => `${ID}/t/${h}.avif`)
		);
	});

	test('a scheduled deletion waits for its time: earlier, processDeletes leaves it', async () => {
		await renderPage('', A, [H(1)]);
		const store = fakeStore();
		const db = fakeDb([job('', A)]);
		const u = uploader(store, db);
		u.schedule(ID, 1);
		await u.drain();
		await renderPage('', 'bbbbbbbbbb', [H(1)]);
		db.jobs = [job('', 'bbbbbbbbbb', 'done', 5000)];
		const v = uploader(store, db, { now: () => 50_000 });
		v.schedule(ID);
		await v.drain();
		expect(v.stats.deletesScheduled).toBe(1);
		expect(db.deletes.get(`${ID}/root.${A}.avif`)).toMatchObject({
			reason: 'replaced',
			not_before: 50_000 + DELETE_GRACE_MS,
			queued_at: 50_000
		});

		// Scheduling it again (another sync) keeps the first time.
		db.uploads.get(`local\n${ID}\n`)!.stale = 1;
		const again = uploader(store, db, { now: () => 60_000 });
		again.schedule(ID);
		await again.drain();
		expect(db.deletes.get(`${ID}/root.${A}.avif`)?.not_before).toBe(50_000 + DELETE_GRACE_MS);

		store.calls.length = 0;
		const early = uploader(store, db, { now: () => 50_000 + DELETE_GRACE_MS - 1 });
		await early.processDeletes();
		expect(store.calls).toEqual([]);
		expect(store.objects.has(`${ID}/root.${A}.avif`)).toBe(true);
		expect(early.deletesPending).toBe(1);
		expect(early.nextDue).toBe(50_000 + DELETE_GRACE_MS);

		const due = uploader(store, db, { now: () => 50_000 + DELETE_GRACE_MS });
		await due.processDeletes();
		expect(store.calls).toEqual([`DELETE ${ID}/root.${A}.avif`]);
		expect(store.objects.has(`${ID}/root.bbbbbbbbbb.avif`)).toBe(true);
		expect(due.deletesPending).toBe(0);
	});

	test('a stamp going A → B → A cancels the deletions of the files A uses again, sent or reused', async () => {
		const B = 'bbbbbbbbbb';
		await renderPage('', A, [H(1), H(7)]);
		const store = fakeStore();
		const db = fakeDb([job('', A)]);
		const u = uploader(store, db);
		u.schedule(ID, 1);
		await u.drain();

		await renderPage('', B, [H(2), H(7)]);
		db.jobs = [job('', B, 'done', 5000)];
		const v = uploader(store, db, { now: () => 10_000 });
		v.schedule(ID);
		await v.drain();
		expect([...db.deletes.keys()].sort()).toEqual([`${ID}/root.${A}.avif`, `${ID}/t/${H(1)}.avif`].sort());

		// Back to A (renderPage rewrites A's overview, so it is sent again; tile 1 is reused from the bucket).
		await renderPage('', A, [H(1), H(7)], '2026-10-20T01:00:00Z');
		db.jobs = [job('', A, 'done', 20_000)];
		store.calls.length = 0;
		const w = uploader(store, db, { now: () => 20_000 });
		w.schedule(ID);
		await w.drain();
		expect(store.calls).not.toContain(`PUT ${ID}/t/${H(1)}.avif`);
		expect([...db.deletes.keys()].sort()).toEqual([`${ID}/root.${B}.avif`, `${ID}/t/${H(2)}.avif`].sort());

		const x = uploader(store, db, { now: () => 20_000 + DELETE_GRACE_MS });
		await x.processDeletes();
		expect([...store.objects.keys()].sort()).toEqual(
			[
				`${ID}/index.json`,
				`${ID}/root.${A}.avif`,
				`${ID}/root.json`,
				`${ID}/root.page.json`,
				`${ID}/t/${H(1)}.avif`,
				`${ID}/t/${H(7)}.avif`
			].sort()
		);
		expect(db.deletes.size).toBe(0);
	});

	test('a due key that the bucket uses again is kept and its row dropped; tiles wait while the uploaded tiles are unknown', async () => {
		const B = 'bbbbbbbbbb';
		await renderPage('', A, [H(1)]);
		const store = fakeStore();
		const db = fakeDb([job('', A)]);
		const u = uploader(store, db);
		u.schedule(ID, 1);
		await u.drain();
		const rowA = { ...db.uploads.get(`local\n${ID}\n`)! };
		await renderPage('', B, [H(2)]);
		db.jobs = [job('', B, 'done', 5000)];
		const v = uploader(store, db, { now: () => 10_000 });
		v.schedule(ID);
		await v.drain();
		expect([...db.deletes.keys()].sort()).toEqual([`${ID}/root.${A}.avif`, `${ID}/t/${H(1)}.avif`].sort());

		// As if B's row had never been written (a crash after its deletions were scheduled): the bucket's
		// record says A again, whose overview must stay; A's tiles aren't on disk any more, so tile 1 waits.
		db.uploads.set(`local\n${ID}\n`, rowA);
		store.calls.length = 0;
		const x = uploader(store, db, { now: () => 10_000 + DELETE_GRACE_MS });
		const tally = await x.processDeletes();
		expect(tally).toMatchObject({ deleted: 0, dropped: 1, waiting: 1, failed: 0 });
		expect(store.calls).toEqual([]);
		expect([...db.deletes.keys()]).toEqual([`${ID}/t/${H(1)}.avif`]);
		expect(store.objects.has(`${ID}/root.${A}.avif`)).toBe(true);

		// Once the bucket's record and the disk agree (B), the tile goes.
		db.uploads.set(`local\n${ID}\n`, { ...rowA, stamp: B, rendered_at: '2026-10-20T00:00:00Z' });
		await renderPage('', B, [H(2)], '2026-10-20T00:00:00Z');
		await x.processDeletes();
		expect(store.calls).toEqual([`DELETE ${ID}/t/${H(1)}.avif`]);
		expect(db.deletes.size).toBe(0);
	});

	test('pages that no longer render leave the index first, then their files go after the grace period', async () => {
		await renderPage('1', 'bbbbbbbbbb', [H(1)]);
		await renderPage('2', 'cccccccccc', [H(2)]);
		const store = fakeStore();
		const db = fakeDb([job('1', 'bbbbbbbbbb'), job('2', 'cccccccccc')]);
		const u = uploader(store, db);
		u.schedule(ID, 2);
		await u.drain();
		db.jobs = [job('1', 'bbbbbbbbbb'), job('2', 'cccccccccc', 'failed')];
		store.calls.length = 0;
		const v = uploader(store, db);
		v.schedule(ID, 0);
		await v.drain();
		expect(store.calls[0]).toBe(`LIST ${ID}/`);
		expect(store.calls[1]).toBe(`PUT ${ID}/index.json`);
		expect(Object.keys(index(store)!.pages)).toEqual(['1']);
		expect(db.uploads.has(`local\n${ID}\n2`)).toBe(false);
		expect(store.objects.has(`${ID}/2.json`)).toBe(true);
		expect(db.deletes.get(`${ID}/2.json`)?.reason).toBe('page removed');
		expect(v.stats).toMatchObject({ removed: 1, replaced: 0 });
		expect(db.deletes.get(`${ID}/t/${H(2)}.avif`)?.reason).toBe('unused');
		const later = () => uploader(store, db, { now: () => 10_000_000 });
		await later().processDeletes();
		expect(store.objects.has(`${ID}/2.json`)).toBe(false);
		expect(store.objects.has(`${ID}/t/${H(2)}.avif`)).toBe(false);
		expect(store.objects.has(`${ID}/1.json`)).toBe(true);

		// The print gone altogether: the index goes at once, the files later.
		db.jobs = [];
		const w = uploader(store, db);
		w.schedule(ID, 0);
		await w.drain();
		expect(store.objects.has(`${ID}/index.json`)).toBe(false);
		expect(store.objects.has(`${ID}/1.json`)).toBe(true);
		await later().processDeletes();
		expect([...store.objects.keys()]).toEqual([]);
	});

	test('deletions retry like uploads, and a stop leaves the rest due', async () => {
		await renderPage('1', 'bbbbbbbbbb', [H(1)]);
		await renderPage('2', 'cccccccccc', [H(2)]);
		const store = fakeStore();
		const db = fakeDb([job('1', 'bbbbbbbbbb'), job('2', 'cccccccccc')]);
		const u = uploader(store, db);
		u.schedule(ID, 2);
		await u.drain();
		db.jobs = [];
		const v = uploader(store, db);
		v.schedule(ID, 0);
		await v.drain();
		const n = db.deletes.size;
		expect(n).toBe(8);

		let fails = 0;
		store.fail((op) => (op === 'delete' && fails++ < 2 ? new StoreError('HTTP 503', true) : null));
		const w = uploader(store, db, { now: () => 10_000_000, concurrency: 1 });
		let stopped = false;
		const real = store.delete.bind(store);
		store.delete = async (key, signal) => {
			await real(key, signal);
			if (!stopped) {
				stopped = true;
				w.stop();
			}
		};
		await w.processDeletes();
		// The first delete went through after two retries; the stop then ended the run's deletions.
		expect(fails).toBe(3);
		expect(w.stats.deleted).toBe(1);
		expect(db.deletes.size).toBe(n - 1);
		store.fail(null);
		store.delete = real;
		await uploader(store, db, { now: () => 10_000_000 }).processDeletes();
		expect(db.deletes.size).toBe(0);
		expect([...store.objects.keys()]).toEqual([]);
	});

	test('a page whose data was rewritten (stale) goes up again; an unchanged one does not', async () => {
		await renderPage('', 'aaaaaaaaaa', [H(1)]);
		const store = fakeStore();
		const db = fakeDb([job('', 'aaaaaaaaaa')]);
		const u = uploader(store, db);
		u.schedule(ID, 1);
		await u.drain();
		expect(planPrint(db.jobs, [...db.uploads.values()]).upload).toEqual([]);
		db.uploads.get(`local\n${ID}\n`)!.stale = 1;
		expect(planPrint(db.jobs, [...db.uploads.values()]).upload.map((j) => j.path)).toEqual(['']);
	});

	test('retryable errors are retried; 403 stops uploading', async () => {
		await renderPage('', 'aaaaaaaaaa', [H(1)]);
		const store = fakeStore();
		let n = 0;
		store.fail((op) => (op === 'put' && n++ < 2 ? new StoreError('HTTP 503', true) : null));
		const db = fakeDb([job('', 'aaaaaaaaaa')]);
		const u = uploader(store, db);
		u.schedule(ID, 1);
		await u.drain();
		expect(u.stats.pages).toBe(1);

		const store2 = fakeStore();
		store2.fail(() => new StoreError('HTTP 403 AccessDenied', false, true));
		const db2 = fakeDb([job('', 'aaaaaaaaaa')]);
		const v = uploader(store2, db2);
		v.schedule(ID, 1);
		await v.drain();
		expect(v.broken).toContain('403');
		expect(v.stats.pages).toBe(0);
	});

	test('stop finishes the page in flight and starts no other', async () => {
		await renderPage('1', 'bbbbbbbbbb', [H(1)]);
		await renderPage('2', 'cccccccccc', [H(2)]);
		const store = fakeStore();
		const db = fakeDb([job('1', 'bbbbbbbbbb'), job('2', 'cccccccccc')]);
		const u = uploader(store, db, { pageConcurrency: 1 });
		let stopped = false;
		store.fail((op, key) => {
			if (!stopped && op === 'put' && key.endsWith('1.bbbbbbbbbb.avif')) {
				stopped = true;
				u.stop();
			}
			return null;
		});
		u.schedule(ID, 2);
		await u.drain();
		expect(Object.keys(index(store)!.pages)).toEqual(['1']);
		expect(store.objects.has(`${ID}/2.json`)).toBe(false);
		expect(u.pending).toBe(1);
		// A page that finishes rendering after the stop isn't sent, but counts as left to upload.
		u.schedule('-Other');
		expect(u.pending).toBe(2);
		expect(store.calls.some((c) => c.includes('-Other'))).toBe(false);
	});
});

/**
 * A bucket that checks the upload's orderings as it goes: a sidecar only once every file it names is
 * up, an index only listing pages whose sidecar (at that stamp) and overview are up, and (through
 * `checkRow`) a row only for a page the index lists. Puts take a pseudo-random time, so pages finish
 * out of order, and it tracks how many pages are in flight at once (first put to sidecar).
 */
function checkedStore() {
	const store = fakeStore();
	const errors: string[] = [];
	const text = (key: string) => {
		const o = store.objects.get(key);
		return o ? new TextDecoder().decode(o.body) : null;
	};
	const started = new Set<string>();
	let inFlight = 0;
	let maxPages = 0;
	let seed = 7;
	const put = store.put.bind(store);
	store.put = async (key, body, type, cacheControl, signal) => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		await new Promise((r) => setTimeout(r, seed % 4));
		const rel = key.slice(ID.length + 1);
		const page = /^(root|\d+(?:\/\d+)*)\./.exec(rel)?.[1];
		if (page && !started.has(page)) {
			started.add(page);
			maxPages = Math.max(maxPages, ++inFlight);
		}
		if (rel === 'index.json') {
			const idx = JSON.parse(new TextDecoder().decode(body)) as RenderIndex;
			for (const [path, p] of Object.entries(idx.pages)) {
				const sc = text(`${ID}/${base(path)}.json`);
				if (!sc || (JSON.parse(sc) as RenderSidecar).stamp !== p.stamp) errors.push(`index lists ${path} before its sidecar`);
				if (!store.objects.has(`${ID}/${p.overview}`)) errors.push(`index lists ${path} before its overview`);
			}
		} else if (page && rel === `${page}.json`) {
			const sc = JSON.parse(new TextDecoder().decode(body)) as RenderSidecar;
			const need = [sc.overview.file, `${page}.page.json`, ...sc.levels.flatMap((l) => l.tiles.filter(Boolean).map((t) => `t/${t}.avif`))];
			for (const n of need) if (!store.objects.has(`${ID}/${n}`)) errors.push(`sidecar ${page} before ${n}`);
			inFlight--;
			started.delete(page);
		}
		return put(key, body, type, cacheControl, signal);
	};
	const checkRow = (row: UploadRow) => {
		const idx = text(`${ID}/index.json`);
		const listedAt = idx ? (JSON.parse(idx) as RenderIndex).pages[row.path]?.stamp : undefined;
		if (listedAt !== row.stamp) errors.push(`row ${row.path} before the index lists it`);
	};
	return { store, errors, checkRow, maxPages: () => maxPages };
}

describe('uploader: pages at once', () => {
	/** Six pages sharing tiles with their neighbours. */
	async function book() {
		const jobs: UploadJob[] = [];
		for (let i = 1; i <= 6; i++) {
			const stamp = String(i).repeat(10);
			await renderPage(String(i), stamp, [H(i), H(i + 1), H(100 + i), i % 2 ? '' : H(1)]);
			jobs.push(job(String(i), stamp));
		}
		return jobs;
	}
	const rowsOf = (db: ReturnType<typeof fakeDb>) =>
		[...db.uploads.values()]
			.map(({ path, stamp, files, bytes, error }) => ({ path, stamp, files, bytes, error }))
			.sort((a, b) => (a.path < b.path ? -1 : 1));

	test('k pages go up at once, sidecars after their files, one index after them, rows after the index; the same objects and rows as one at a time', async () => {
		const jobs = await book();
		const one = fakeStore();
		const oneDb = fakeDb(jobs);
		const serial = uploader(one, oneDb, { pageConcurrency: 1 });
		serial.schedule(ID, 6);
		await serial.drain();

		const c = checkedStore();
		const db = fakeDb(jobs);
		const record = db.recordUpload;
		db.recordUpload = async (row) => {
			c.checkRow(row);
			return record(row);
		};
		const ups: [string, number, number][] = [];
		const u = uploader(c.store, db, { pageConcurrency: 3, onPageUp: (id, files, bytes) => ups.push([id, files, bytes]) });
		u.schedule(ID, 6);
		await u.drain();
		expect(c.errors).toEqual([]);
		expect(c.maxPages()).toBeGreaterThan(1);
		expect(c.maxPages() <= 3).toBe(true);
		expect(c.store.calls.filter((x) => x === `PUT ${ID}/index.json`).length).toBe(1);
		// Every tile once, credited to the first page in book order that uses it, as one at a time would.
		expect(c.store.calls.filter((x) => x.startsWith('PUT')).sort()).toEqual(one.calls.filter((x) => x.startsWith('PUT')).sort());
		expect([...c.store.objects.keys()].sort()).toEqual([...one.objects.keys()].sort());
		for (const [k, o] of one.objects) {
			expect(c.store.objects.get(k)?.type).toBe(o.type);
			expect(c.store.objects.get(k)?.body).toEqual(o.body);
		}
		expect(rowsOf(db)).toEqual(rowsOf(oneDb));
		expect(u.stats).toMatchObject({ pages: 6, files: serial.stats.files, bytes: serial.stats.bytes });
		expect(ups.reduce((n, [, f]) => n + f, 0)).toBe(u.stats.files);
		expect(u.pending).toBe(0);
		expect(u.failing).toBe(0);
		await u.settled(ID);
	});

	test('with the index going up as pages finish, no row is ever written before an index lists its page', async () => {
		const jobs = await book();
		const c = checkedStore();
		const db = fakeDb(jobs);
		const record = db.recordUpload;
		db.recordUpload = async (row) => {
			c.checkRow(row);
			return record(row);
		};
		const u = uploader(c.store, db, { pageConcurrency: 4, indexEveryMs: 0 });
		u.schedule(ID, 6);
		await u.drain();
		expect(c.errors).toEqual([]);
		expect(c.store.calls.filter((x) => x === `PUT ${ID}/index.json`).length).toBeGreaterThan(1);
		expect(Object.keys(index(c.store)!.pages)).toEqual(['1', '2', '3', '4', '5', '6']);
		expect(db.uploads.size).toBe(6);
	});

	test("a shared tile whose page fails before sending it is sent by the next page that uses it, before that page's sidecar", async () => {
		await renderPage('1', 'bbbbbbbbbb', [H(1), H(2)]);
		await renderPage('2', 'cccccccccc', [H(2), H(3)]);
		const c = checkedStore();
		c.store.fail((op, key) => (op === 'put' && key.endsWith(`t/${H(1)}.avif`) ? new StoreError('gone', false) : null));
		const db = fakeDb([job('1', 'bbbbbbbbbb'), job('2', 'cccccccccc')]);
		// One request at a time: page 1 stops at tile 1, so tile 2 (claimed by page 1) is never sent by it.
		const u = uploader(c.store, db, { concurrency: 1, maxRounds: 1 });
		u.schedule(ID, 2);
		await u.drain();
		expect(c.errors).toEqual([]);
		expect(Object.keys(index(c.store)!.pages)).toEqual(['2']);
		expect(c.store.calls.filter((x) => x === `PUT ${ID}/t/${H(2)}.avif`).length).toBe(1);
		expect(db.uploads.get(`local\n${ID}\n2`)?.files).toBe(5);
		expect(db.uploads.get(`local\n${ID}\n1`)?.error).toContain('gone');
		expect(u.failing).toBe(1);
		expect(u.pending).toBe(1);
	});

	test('stop finishes the pages in flight, lists them and writes their rows, and starts no other', async () => {
		const jobs = await book();
		const store = fakeStore();
		const db = fakeDb(jobs);
		const u = uploader(store, db, { pageConcurrency: 2 });
		let stopped = false;
		store.fail((op, key) => {
			if (!stopped && op === 'put' && key.endsWith('1.1111111111.avif')) {
				stopped = true;
				u.stop();
			}
			return null;
		});
		u.schedule(ID, 6);
		await u.drain();
		expect(Object.keys(index(store)!.pages)).toEqual(['1', '2']);
		expect([...db.uploads.values()].map((r) => r.path).sort()).toEqual(['1', '2']);
		expect(store.objects.has(`${ID}/3.json`)).toBe(false);
		expect(u.pending).toBe(4);
	});

	test('a tile that fails leaves the page data and sidecar unsent (the bucket keeps the old pair)', async () => {
		await renderPage('', A, [H(1), H(2)]);
		const store = fakeStore();
		store.fail((op, key) => (op === 'put' && key.endsWith(`t/${H(2)}.avif`) ? new StoreError('gone', false) : null));
		const u = uploader(store, fakeDb([job('', A)]), { maxRounds: 1 });
		u.schedule(ID, 1);
		await u.drain();
		expect(store.objects.has(`${ID}/root.page.json`)).toBe(false);
		expect(store.objects.has(`${ID}/root.json`)).toBe(false);
		expect(u.failing).toBe(1);
	});

	test('once uploads break (403), pages in flight send nothing more and no sidecar', async () => {
		const jobs = await book();
		const store = fakeStore();
		let n = 0;
		// The fourth put is refused: by then pages are part-way through their files.
		store.fail((op) => (op === 'put' && ++n === 4 ? new StoreError('HTTP 403 AccessDenied', false, true) : null));
		const u = uploader(store, fakeDb(jobs), { concurrency: 2, pageConcurrency: 3 });
		u.schedule(ID, 6);
		await u.drain();
		expect(u.broken).toContain('403');
		// One put may have been in flight beside the refused one; nothing starts after it.
		expect(store.calls.filter((c) => c.startsWith('PUT')).length <= 4).toBe(true);
		expect(store.calls.some((c) => /\/\d\.json$/.test(c) || c.endsWith('index.json'))).toBe(false);
	});

	test('an abort while an index goes up and pages are in flight: sync returns only once every page has stopped, with no unhandled rejection', async () => {
		const jobs = await book();
		const store = fakeStore();
		const db = fakeDb(jobs);
		let u: ReturnType<typeof uploader> | null = null;
		const put = store.put.bind(store);
		store.put = async (key, body, type, cacheControl, signal) => {
			if (key.endsWith('index.json')) {
				u!.abort();
				signal?.throwIfAborted();
			}
			await new Promise((r) => setTimeout(r, 2));
			return put(key, body, type, cacheControl, signal);
		};
		let settledAt = -1;
		const writes: number[] = [];
		const record = db.recordUpload;
		db.recordUpload = async (row) => {
			writes.push(Date.now());
			return record(row);
		};
		const recordFailure = db.recordFailure;
		db.recordFailure = async (...a) => {
			writes.push(Date.now());
			return recordFailure(...a);
		};
		u = uploader(store, db, { pageConcurrency: 3, indexEveryMs: 0 });
		u.schedule(ID, 6);
		await u.drain();
		await u.settled(ID);
		settledAt = Date.now();
		await new Promise((r) => setTimeout(r, 30));
		expect(writes.every((t) => t <= settledAt)).toBe(true);
		expect(u.inFlight).toBe(0);
		expect(db.uploads.size).toBe(0);
	});

	test('an index that fails leaves no rows: its pages count as failed and go up again', async () => {
		const jobs = await book();
		const store = fakeStore();
		let fails = 1;
		store.fail((op, key) => (op === 'put' && key.endsWith('index.json') && fails-- > 0 ? new StoreError('HTTP 400', false) : null));
		const db = fakeDb(jobs);
		const u = uploader(store, db, { maxRounds: 1 });
		u.schedule(ID, 6);
		await u.drain();
		expect(store.objects.has(`${ID}/index.json`)).toBe(false);
		expect([...db.uploads.values()].every((r) => r.stamp === null && r.error?.includes('HTTP 400'))).toBe(true);
		expect(u.failing).toBe(6);
		expect(u.stats.pages).toBe(0);

		store.calls.length = 0;
		const v = uploader(store, db);
		v.schedule(ID);
		await v.drain();
		expect(Object.keys(index(store)!.pages)).toEqual(['1', '2', '3', '4', '5', '6']);
		expect(v.stats.pages).toBe(6);
		// The tiles made it up the first time: only each page's overview, page data and sidecar go again.
		expect(store.calls.filter((x) => x.includes('/t/'))).toEqual([]);
	});
});

describe('rate window', () => {
	test('per second over the window, from the first activity, forgetting what slid out', () => {
		let t = 0;
		const w = rateWindow(60_000, () => t);
		expect(w.perSecond()).toBe(null);
		t = 1_000;
		w.start();
		t = 11_000;
		w.add(5_000_000);
		// 10 s since the start, not the whole minute.
		expect(w.perSecond()).toBe(500_000);
		t = 71_000;
		w.add(3_000_000);
		// The first amount slid out at 71 s; the window is a full minute now.
		expect(w.perSecond()).toBe(50_000);
		t = 200_000;
		expect(w.perSecond()).toBe(0);
	});
});

describe('store helpers', () => {
	test('parseListXml', () => {
		const xml = `<?xml version="1.0"?><ListBucketResult><Contents><Key>a/t/1.avif</Key></Contents><Contents><Key>a/x&amp;y.json</Key></Contents>
			<IsTruncated>true</IsTruncated><NextContinuationToken>tok&amp;1</NextContinuationToken></ListBucketResult>`;
		expect(parseListXml(xml)).toEqual({ keys: ['a/t/1.avif', 'a/x&y.json'], next: 'tok&1' });
		expect(parseListXml('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>')).toEqual({ keys: [], next: null });
	});

	test('withRetries retries only retryable errors', async () => {
		let n = 0;
		const slept: number[] = [];
		const sleep = async (ms: number) => {
			slept.push(ms);
		};
		expect(
			await withRetries(
				async () => {
					if (n++ < 3) throw new StoreError('503', true);
					return 'ok';
				},
				{ sleep }
			)
		).toBe('ok');
		expect(slept.length).toBe(3);
		expect(slept[1]).toBeGreaterThan(slept[0]);
		await expect(withRetries(async () => Promise.reject(new StoreError('400', false)), { sleep })).rejects.toThrow('400');
		n = 0;
		await expect(withRetries(async () => Promise.reject(new StoreError(`503 #${++n}`, true)), { sleep, attempts: 3 })).rejects.toThrow(
			'#3'
		);
	});
});

describe('args', () => {
	const defaults = defaultArgs({ threads: 16, ramMb: 32_000 });
	test('parse and resolve', () => {
		const { given, resume } = parseArgs(['--from-clone', '/m', '--next', '100', '--upload', 'prod', '--workers', '6'], '/raw');
		expect(resume).toBe(false);
		const a = resolveArgs(given, defaults);
		expect(a).toMatchObject({ clone: '/m', disk: null, next: 100, upload: 'prod', workers: 6, uploadConcurrency: 32 });
		expect(() => resolveArgs(parseArgs(['--from-clone', '/m', '--next', '5', '--limit', '3'], '/raw').given, defaults)).toThrow(UsageError);
		expect(() => parseArgs(['--upload', 'dev'], '/raw')).toThrow(UsageError);
		expect(() => resolveArgs(parseArgs(['--from-clone', '/m', '--plan-only', '--upload', 'local'], '/raw').given, defaults)).toThrow(
			UsageError
		);
		expect(parseArgs(['--from-disk'], '/raw').given.disk).toBe('/raw');
	});

	test('resume: same options, a finished batch keeps its prints, force only for pages left pending, flags override', () => {
		const args = resolveArgs(parseArgs(['--from-clone', '/m', '--next', '3', '--force', '--upload', 'local'], '/raw').given, defaults);
		const r = resumeArgs({ args, batch: { next: 3, picked: ['a', 'b', 'c'], complete: true } }, 'run1', {});
		expect(r.args).toMatchObject({ clone: '/m', ids: ['a', 'b', 'c'], next: null, batchOf: 3, force: 'pending', upload: 'local' });
		expect(r.summary).toContain('batch of 3');
		// An unfinished pick is picked again.
		expect(resumeArgs({ args, batch: { next: 3, picked: ['a'], complete: false } }, 'run1', {}).args).toMatchObject({ next: 3, ids: null });
		// Flags given now win.
		const o = resumeArgs(
			{ args, batch: { next: 3, picked: ['a'], complete: true } },
			'run1',
			parseArgs(['--workers', '2', '--next', '9'], '').given
		);
		expect(o.args).toMatchObject({ workers: 2, next: 9, ids: null, batchOf: null });
		expect(() => resumeArgs({}, 'old', {})).toThrow(UsageError);
		expect(mergeArgs(args, { disk: '/d' })).toMatchObject({ disk: '/d', clone: null });
	});

	test('--retry-failed applies to its own run only, unless given again', () => {
		const args = resolveArgs(parseArgs(['--from-clone', '/m', '--retry-failed'], '/raw').given, defaults);
		expect(args.retryFailed).toBe(true);
		expect(resolveArgs(parseArgs(['--from-clone', '/m'], '/raw').given, defaults).retryFailed).toBe(false);
		expect(resumeArgs({ args }, 'run1', {}).args.retryFailed).toBe(false);
		expect(resumeArgs({ args }, 'run1', { retryFailed: true }).args.retryFailed).toBe(true);
	});
});
