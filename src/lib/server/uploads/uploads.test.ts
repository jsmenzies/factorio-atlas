import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountChores } from '../auth/sessions';
import { signInAccount, deleteAccount, markDeleting, type Account } from '../auth/users';
import { sha256Hex } from '../hash';
import { d1FromSqlite } from '../pipeline/d1-sqlite';
import type { GateOutcome, PurgeExtras, SourceRecord, UploadGate } from './gate';
import { approveImage, pendingImages, rejectImage } from './images';
import {
	checkInput,
	createUpload,
	deleteAccountUploads,
	deleteUpload,
	EDITS_PER_DAY,
	editUpload,
	admitProcessing,
	imageKey,
	listUploads,
	PROCESSING_ATTEMPTS,
	processingUploads,
	newSiteId,
	IMAGES_PER_DAY,
	PROCESSING_MAX,
	readRecord,
	recordKey,
	siteIdOf,
	sniffImage,
	isUploadId,
	uploadPurgeExtras,
	UPLOADS_PER_DAY,
	type UploadInput
} from './uploads';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const STRING = '0eNqrVkrKKU0tKMrMK1GyqlYqLkksKS1WsoqOrQUAhKMJmg==';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

/** An R2 bucket in memory: enough of get, head, put and delete. */
const memoryBucket = () => {
	const objects = new Map<string, Uint8Array | string>();
	const bucket = {
		get: async (k: string) => {
			const v = objects.get(k);
			return v === undefined ? null : { json: async () => JSON.parse(String(v)), text: async () => String(v) };
		},
		head: async (k: string) => (objects.has(k) ? { key: k } : null),
		put: async (k: string, v: Uint8Array | string) => void objects.set(k, v),
		delete: async (k: string | string[]) => {
			for (const key of Array.isArray(k) ? k : [k]) objects.delete(key);
		}
	} as unknown as R2Bucket;
	return { bucket, objects };
};

/** A gate that answers `outcome` (or what `answer` says per call), ingesting admitted records' `extra` as the pipeline would. */
const fakeGate = (db: D1Database, answer: (record: SourceRecord) => GateOutcome) => {
	const calls = { admit: [] as SourceRecord[], gone: [] as { siteId: string; extras: PurgeExtras }[] };
	const blocked = new Set<string>();
	const gate: UploadGate = {
		admit: async (record, printId, extra) => {
			calls.admit.push(record);
			const outcome = answer(record);
			if (outcome.status === 'admitted') await db.batch(extra);
			return outcome.status === 'admitted' ? { ...outcome, printId } : outcome;
		},
		sourceGone: async (siteId, extras) => {
			calls.gone.push({ siteId, extras });
			return 'purged';
		},
		imageBlocked: async (id) => blocked.has(id)
	};
	return { gate, calls, blocked };
};

const admitted: GateOutcome = { status: 'admitted', printId: '', suggestions: [] };

const setup = async (answer: (record: SourceRecord) => GateOutcome = () => admitted) => {
	const sqlite = new Database(':memory:');
	for (const f of readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.sort())
		sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
	const db = d1FromSqlite(sqlite);
	const raw = memoryBucket();
	const g = fakeGate(db, answer);
	const account = async (name: string): Promise<Account> => {
		const r = await signInAccount(db, 'github', { subject: name, name });
		if (!r.ok) throw new Error('banned');
		return r.account;
	};
	const deps = { db, raw: raw.bucket, gate: g.gate, origin: 'https://example.com', now: 1_000_000 };
	const rows = () => sqlite.query(`SELECT * FROM uploads ORDER BY created_at`).all() as Record<string, unknown>[];
	const images = () => sqlite.query(`SELECT * FROM upload_images`).all() as Record<string, unknown>[];
	return { sqlite, db, raw, deps, account, rows, images, ...g };
};

const input = (over: Partial<UploadInput> = {}): UploadInput => ({
	title: 'Red science',
	description: 'Five assemblers.',
	blueprintString: STRING,
	image: null,
	...over
});

describe('ids, images and input', () => {
	test('upload ids are up- and 10 base62 characters, random', () => {
		const ids = new Set(Array.from({ length: 500 }, newSiteId));
		expect(ids.size).toBe(500);
		for (const id of ids) expect(isUploadId(`up-${id}`)).toBe(true);
	});
	test('image types come from the bytes', () => {
		expect(sniffImage(PNG)).toBe('png');
		expect(sniffImage(JPEG)).toBe('jpg');
		expect(sniffImage(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('webp');
		expect(sniffImage(new TextEncoder().encode('GIF89a'))).toBe('gif');
		expect(sniffImage(new TextEncoder().encode('<svg></svg>'))).toBeNull();
	});
	test('the form is cleaned and checked', () => {
		const ok = checkInput(input({ title: '  Red\u0007  science\n', description: 'a\r\nb\u0000' }));
		expect(ok.ok && [ok.value.title, ok.value.description]).toEqual(['Red science', 'a\nb']);
		// Bidi embeddings, overrides and isolates go: no title can read backwards.
		const bidi = checkInput(input({ title: 'Red \u202Eecneics\u202C', description: '\u2066a\u2069 \u202Ab\u202D' }));
		expect(bidi.ok && [bidi.value.title, bidi.value.description]).toEqual(['Red ecneics', 'a b']);
		expect(checkInput(input({ title: ' ' }))).toMatchObject({ ok: false });
		expect(checkInput(input({ title: 'x'.repeat(121) }))).toMatchObject({ ok: false });
		expect(checkInput(input({ blueprintString: 'hello there' }))).toMatchObject({ ok: false });
		expect(checkInput(input({ blueprintString: '{"blueprint":{}}' }))).toMatchObject({ ok: true });
		expect(checkInput(input({ image: new TextEncoder().encode('<svg/>') }))).toMatchObject({ ok: false });
	});
});

describe('a new upload', () => {
	test('admitted: the record in RAW, the row live in the ingest’s batch, the screenshot pending', async () => {
		const s = await setup();
		const ada = await s.account('Ada');
		const r = await createUpload(s.deps, ada, input({ image: PNG }));
		expect(r).toMatchObject({ ok: true, state: 'live' });
		const printId = r.ok ? r.printId : '';
		expect(isUploadId(printId)).toBe(true);
		const record = await readRecord(s.raw.bucket, printId);
		const imageId = (await sha256Hex(PNG)).slice(0, 16);
		expect(record).toEqual({
			site: 'upload',
			siteId: siteIdOf(printId),
			url: `https://example.com/prints/${printId}`,
			title: 'Red science',
			description: 'Five assemblers.',
			author: { site: 'upload', id: ada.id, name: 'Ada' },
			blueprintString: STRING,
			// Pending: never in the record, so the print shows no screenshot until an admin approves it.
			image: null,
			uploadedAt: 1_000_000,
			updatedAt: 1_000_000,
			// Stored as the pipeline's text (toPipelineText), which counts no favourites as 0.
			favorites: 0,
			tags: [],
			sourceHints: []
		});
		expect(s.calls.admit[0]).toEqual({ ...record!, favorites: null, tags: undefined });
		expect(s.rows()).toMatchObject([{ print_id: printId, state: 'live', title: 'Red science', image_id: imageId, live_at: 1_000_000 }]);
		expect(s.images()).toMatchObject([{ id: imageId, ext: 'png', status: 'pending', user_id: ada.id }]);
		expect(s.raw.objects.get(imageKey(imageId, 'png'))).toEqual(PNG);
	});

	test('over the Worker’s cap, or before the gate is wired: stored as processing for the sync', async () => {
		let next: GateOutcome = { status: 'too-big', by: 'string', size: 600_000, limit: 524_288 };
		const s = await setup(() => next);
		const ada = await s.account('Ada');
		const big = await createUpload(s.deps, ada, input());
		expect(big).toMatchObject({ ok: true, state: 'processing' });
		expect(s.rows()).toMatchObject([{ state: 'processing', too_big: 'string', live_at: null }]);
		expect(s.raw.objects.has(recordKey(siteIdOf(big.ok ? big.printId : '')))).toBe(true);
		next = { status: 'deferred', reason: 'test' };
		const waiting = await createUpload(s.deps, ada, input());
		expect(waiting).toMatchObject({ ok: true, state: 'processing' });
		expect(s.rows().find((r) => r.print_id === (waiting.ok ? waiting.printId : ''))).toMatchObject({ state: 'processing', too_big: null });
	});

	test('at most PROCESSING_MAX big uploads wait per account; the refused one leaves nothing behind', async () => {
		const s = await setup(() => ({ status: 'too-big', by: 'entities', size: 200_000, limit: 150_000 }));
		const ada = await s.account('Ada');
		for (let i = 0; i < PROCESSING_MAX; i++) expect(await createUpload(s.deps, ada, input())).toMatchObject({ ok: true });
		const before = s.raw.objects.size;
		expect(await createUpload(s.deps, ada, input({ image: PNG }))).toMatchObject({ ok: false, status: 429 });
		expect(s.raw.objects.size).toBe(before);
		expect(s.rows().length).toBe(PROCESSING_MAX);
	});

	test('blocked or undecodable: refused, with no rows and no RAW objects', async () => {
		for (const outcome of [{ status: 'blocked' }, { status: 'undecodable', reason: 'zlib' }] as GateOutcome[]) {
			const s = await setup(() => outcome);
			const r = await createUpload(s.deps, await s.account('Ada'), input({ image: PNG }));
			expect(r.ok).toBe(false);
			expect(s.rows().length + s.images().length + s.raw.objects.size).toBe(0);
		}
	});

	test('an exact copy is refused with a link, which says Edit when it is the account’s own upload', async () => {
		let next: GateOutcome = admitted;
		const s = await setup(() => next);
		const ada = await s.account('Ada');
		const grace = await s.account('Grace');
		const first = await createUpload(s.deps, ada, input());
		const printId = first.ok ? first.printId : '';
		next = { status: 'exists', printId, sources: [{ site: 'upload', siteId: siteIdOf(printId), goneAt: null }] };
		expect(await createUpload(s.deps, ada, input())).toMatchObject({ ok: false, status: 409, existing: { printId, own: true } });
		expect(await createUpload(s.deps, grace, input())).toMatchObject({ ok: false, status: 409, existing: { printId, own: false } });
		next = {
			status: 'exists',
			printId: 'abcdefghij0123456789',
			sources: [{ site: 'factorioprints', siteId: 'abcdefghij0123456789', goneAt: null }]
		};
		expect(await createUpload(s.deps, ada, input())).toMatchObject({ ok: false, existing: { own: false } });
		expect(s.rows().length).toBe(1);
		expect(s.raw.objects.size).toBe(1);
	});

	test('daily caps, and screenshots rejected or blocked before', async () => {
		const s = await setup();
		const ada = await s.account('Ada');
		const rejected = await sha256Hex(PNG2);
		s.sqlite
			.query(`INSERT INTO upload_images (id, sha256, ext, bytes, user_id, status, created_at) VALUES (?, ?, 'png', 1, 'x', 'rejected', 0)`)
			.run(rejected.slice(0, 16), rejected);
		expect(await createUpload(s.deps, ada, input({ image: PNG2 }))).toMatchObject({ ok: false, problem: 'That screenshot can’t be used.' });
		s.blocked.add((await sha256Hex(JPEG)).slice(0, 16));
		expect(await createUpload(s.deps, ada, input({ image: JPEG }))).toMatchObject({ ok: false, problem: 'That screenshot can’t be used.' });
		for (let i = 0; i < UPLOADS_PER_DAY; i++) await createUpload(s.deps, ada, input());
		expect(await createUpload(s.deps, ada, input())).toMatchObject({ ok: false, status: 429 });
		// A day later there's room again.
		expect(await createUpload({ ...s.deps, now: s.deps.now + 86_400_001 }, ada, input())).toMatchObject({ ok: true });
	});
});

describe('the daily caps', () => {
	test('deleting uploads doesn’t give them back; screenshots added by edits count; the next UTC day starts again', async () => {
		const s = await setup();
		const ada = await s.account('Ada');
		for (let i = 0; i < UPLOADS_PER_DAY; i++) {
			const r = await createUpload(s.deps, ada, input());
			expect(r.ok).toBe(true);
			await deleteUpload(s.deps, ada.id, r.ok ? r.printId : '');
		}
		expect(s.rows().length).toBe(0);
		expect(await createUpload(s.deps, ada, input())).toMatchObject({ ok: false, status: 429 });
		expect(s.sqlite.query(`SELECT day, uploads, images FROM upload_quota`).all()).toEqual([
			{ day: 0, uploads: UPLOADS_PER_DAY, images: 0 }
		]);

		// Screenshots: new uploads' and edits' alike.
		const tomorrow = { ...s.deps, now: 86_400_000 + 5 };
		const r = await createUpload(tomorrow, ada, input());
		const printId = r.ok ? r.printId : '';
		for (let i = 0; i < IMAGES_PER_DAY; i++) {
			const bytes = new Uint8Array([...PNG, i]);
			expect(await editUpload(tomorrow, ada, printId, input({ image: bytes }))).toMatchObject({ ok: true });
		}
		expect(await editUpload(tomorrow, ada, printId, input({ image: new Uint8Array([...PNG, 99]) }))).toMatchObject({
			ok: false,
			status: 429
		});
		expect(await createUpload(tomorrow, ada, input({ image: PNG2 }))).toMatchObject({ ok: false, status: 429 });
		expect(s.sqlite.query(`SELECT uploads, images FROM upload_quota WHERE day = 1`).get()).toEqual({ uploads: 1, images: IMAGES_PER_DAY });
		// A refused upload counts nothing.
		const refusing = await setup(() => ({ status: 'blocked' }));
		const grace = await refusing.account('Grace');
		await createUpload(refusing.deps, grace, input({ image: PNG }));
		expect(refusing.sqlite.query(`SELECT uploads, images FROM upload_quota`).get()).toEqual({ uploads: 0, images: 0 });
	});

	test('the counts go with the account, and the daily chores keep only today’s and yesterday’s', async () => {
		const s = await setup();
		const ada = await s.account('Ada');
		const grace = await s.account('Grace');
		for (const day of [0, 1, 2, 3]) await createUpload({ ...s.deps, now: day * 86_400_000 + 1 }, grace, input());
		await createUpload(s.deps, ada, input());
		await deleteAccountUploads(s.deps, ada.id);
		await deleteAccount(s.db, ada.id);
		expect(s.sqlite.query(`SELECT count(*) AS n FROM upload_quota WHERE user_id = ?`).get(ada.id)).toEqual({ n: 0 });
		await accountChores(s.db, 3 * 86_400_000 + 10);
		expect(s.sqlite.query(`SELECT day FROM upload_quota ORDER BY day`).all()).toEqual([{ day: 2 }, { day: 3 }]);
	});
});

describe('editing an upload', () => {
	test('keeps the URL and the string when it’s left empty, and replaces the screenshot', async () => {
		const s = await setup();
		const ada = await s.account('Ada');
		const r = await createUpload(s.deps, ada, input({ image: PNG }));
		const printId = r.ok ? r.printId : '';
		const oldImage = (await sha256Hex(PNG)).slice(0, 16);
		const later = { ...s.deps, now: 2_000_000 };
		expect(await editUpload(later, ada, printId, input({ title: 'Red science v2', blueprintString: '', image: PNG2 }))).toMatchObject({
			ok: true,
			printId,
			state: 'live'
		});
		const record = await readRecord(s.raw.bucket, printId);
		expect(record).toMatchObject({ title: 'Red science v2', blueprintString: STRING, uploadedAt: 1_000_000, updatedAt: 2_000_000 });
		const newImage = (await sha256Hex(PNG2)).slice(0, 16);
		expect(s.rows()).toMatchObject([{ title: 'Red science v2', image_id: newImage, updated_at: 2_000_000 }]);
		// The old screenshot, used by no other upload, is gone with its RAW original.
		expect(s.images().map((i) => i.id)).toEqual([newImage]);
		expect(s.raw.objects.has(imageKey(oldImage, 'png'))).toBe(false);
		// Removing it.
		await editUpload(later, ada, printId, input({ image: 'remove' }));
		expect(s.rows()[0].image_id).toBeNull();
		expect(s.images().length).toBe(0);
	});

	test('a refused edit changes nothing; someone else’s upload is a 404', async () => {
		let next: GateOutcome = admitted;
		const s = await setup(() => next);
		const ada = await s.account('Ada');
		const r = await createUpload(s.deps, ada, input());
		const printId = r.ok ? r.printId : '';
		const before = await readRecord(s.raw.bucket, printId);
		next = { status: 'undecodable', reason: 'json' };
		expect(await editUpload(s.deps, ada, printId, input({ title: 'Broken', blueprintString: '0AAAA' }))).toMatchObject({
			ok: false,
			status: 400
		});
		expect(await readRecord(s.raw.bucket, printId)).toEqual(before);
		expect(s.rows()[0].title).toBe('Red science');
		expect(await editUpload(s.deps, await s.account('Grace'), printId, input())).toMatchObject({ ok: false, status: 404 });
	});

	test('an edit over the cap waits for the sync; the live print stays', async () => {
		let next: GateOutcome = admitted;
		const s = await setup(() => next);
		const ada = await s.account('Ada');
		const r = await createUpload(s.deps, ada, input());
		next = { status: 'too-big', by: 'string', size: 1, limit: 0 };
		expect(await editUpload(s.deps, ada, r.ok ? r.printId : '', input({ title: 'Huge' }))).toMatchObject({ ok: true, state: 'processing' });
		expect(s.rows()).toMatchObject([{ state: 'processing', too_big: 'string', live_at: 1_000_000, title: 'Huge' }]);
	});
});

describe('deleting', () => {
	test('a live upload goes through sourceGone with its purge extras, then its rows and RAW objects go', async () => {
		const s = await setup();
		const ada = await s.account('Ada');
		const r = await createUpload(s.deps, ada, input({ image: PNG }));
		const printId = r.ok ? r.printId : '';
		const imageId = (await sha256Hex(PNG)).slice(0, 16);
		expect(await deleteUpload(s.deps, (await s.account('Grace')).id, printId)).toBe(false);
		expect(await deleteUpload(s.deps, ada.id, printId)).toBe(true);
		expect(s.calls.gone.length).toBe(1);
		expect(s.calls.gone[0].siteId).toBe(siteIdOf(printId));
		expect(s.calls.gone[0].extras.extraKeys).toEqual([recordKey(siteIdOf(printId)), imageKey(imageId, 'png')]);
		expect(s.rows().length + s.images().length + s.raw.objects.size).toBe(0);
	});

	test('a processing upload needs no sourceGone; a shared screenshot stays for the other upload', async () => {
		let next: GateOutcome = { status: 'deferred', reason: 'test' };
		const s = await setup(() => next);
		const ada = await s.account('Ada');
		const a = await createUpload(s.deps, ada, input({ image: PNG }));
		next = admitted;
		const b = await createUpload(s.deps, ada, input({ title: 'Other', image: PNG }));
		const imageId = (await sha256Hex(PNG)).slice(0, 16);
		const extras = await uploadPurgeExtras(s.db, a.ok ? a.printId : '');
		expect(extras.extraKeys).toEqual([recordKey(siteIdOf(a.ok ? a.printId : ''))]);
		await deleteUpload(s.deps, ada.id, a.ok ? a.printId : '');
		expect(s.calls.gone.length).toBe(0);
		expect(s.images().length).toBe(1);
		expect(s.raw.objects.has(imageKey(imageId, 'png'))).toBe(true);
		await deleteUpload(s.deps, ada.id, b.ok ? b.printId : '');
		expect(s.images().length + s.raw.objects.size).toBe(0);
	});

	test('deleting an account deletes its uploads first', async () => {
		const s = await setup();
		const ada = await s.account('Ada');
		const grace = await s.account('Grace');
		await createUpload(s.deps, ada, input());
		await createUpload(s.deps, ada, input({ image: JPEG }));
		await createUpload(s.deps, grace, input());
		expect(await deleteAccountUploads(s.deps, ada.id)).toEqual({ deleted: 2, left: 0 });
		await deleteAccount(s.db, ada.id);
		expect(s.rows().map((r) => r.user_id)).toEqual([grace.id]);
		expect(s.raw.objects.size).toBe(1);
		expect(s.calls.gone.length).toBe(2);
	});

	test('an account with too many uploads for one request is deleted over several, and only then the account', async () => {
		const s = await setup();
		const ada = await s.account('Ada');
		for (const image of [PNG, PNG2, null]) await createUpload(s.deps, ada, input({ image }));
		const grace = await s.account('Grace');
		await createUpload(s.deps, grace, input({ image: PNG }));
		await markDeleting(s.db, ada.id);
		// A clock that runs out after one upload.
		let t = 0;
		const clock = () => (t += 10);
		expect(await deleteAccountUploads(s.deps, ada.id, { budgetMs: 15, clock })).toEqual({ deleted: 1, left: 2 });
		expect(await deleteAccount(s.db, ada.id)).toBe(false);
		expect(s.sqlite.query(`SELECT count(*) AS n FROM users WHERE id = ?`).get(ada.id)).toEqual({ n: 1 });
		// Meanwhile it can't upload or edit.
		const deleting = { ...ada, deleting: true };
		expect(await createUpload(s.deps, deleting, input())).toMatchObject({ ok: false, status: 409 });
		expect(await deleteAccountUploads(s.deps, ada.id)).toEqual({ deleted: 2, left: 0 });
		expect(await deleteAccount(s.db, ada.id)).toBe(true);
		// The screenshot Grace's upload shares outlives Ada's account, without her id.
		expect(s.images().map((i) => i.user_id)).toEqual([null]);
		expect(s.rows().map((r) => r.user_id)).toEqual([grace.id]);
	});
});

describe('the review’s fixes', () => {
	test('parallel uploads can’t pass the daily cap', async () => {
		const s = await setup();
		const ada = await s.account('Ada');
		const results = await Promise.all(Array.from({ length: UPLOADS_PER_DAY + 5 }, () => createUpload(s.deps, ada, input())));
		expect(results.filter((r) => r.ok).length).toBe(UPLOADS_PER_DAY);
		expect(results.filter((r) => !r.ok && r.status === 429).length).toBe(5);
		expect(s.sqlite.query(`SELECT uploads FROM upload_quota`).get()).toEqual({ uploads: UPLOADS_PER_DAY });
	});
	test('edits have a daily cap of their own; a refused edit doesn’t count', async () => {
		let next: GateOutcome = admitted;
		const s = await setup(() => next);
		const ada = await s.account('Ada');
		const r = await createUpload(s.deps, ada, input());
		const id = r.ok ? r.printId : '';
		next = { status: 'blocked' };
		await editUpload(s.deps, ada, id, input({ title: 'Blocked' }));
		next = admitted;
		for (let i = 0; i < EDITS_PER_DAY; i++)
			expect(await editUpload(s.deps, ada, id, input({ title: `v${i}` }))).toMatchObject({ ok: true });
		expect(await editUpload(s.deps, ada, id, input({ title: 'one too many' }))).toMatchObject({ ok: false, status: 429 });
	});
	test('every admitted upload and edit bumps the page cache in the ingest’s batch', async () => {
		const s = await setup();
		const ada = await s.account('Ada');
		const version = () => (s.sqlite.query(`SELECT value FROM meta WHERE key = 'sync_version'`).get() as { value: string } | null)?.value;
		const r = await createUpload(s.deps, ada, input());
		expect(version()).toBe('1000000');
		await editUpload({ ...s.deps, now: 2_000_000 }, ada, r.ok ? r.printId : '', input({ title: 'New title' }));
		expect(version()).toBe('2000000');
	});
	test('a failure after the gate’s batch committed leaves the upload live: no 500, no second count', async () => {
		// The gate writes the batch, then something after it (the fold) fails: 'deferred'.
		const s = await setup();
		const committing: UploadGate = {
			...s.gate,
			admit: async (_record, _printId, extra) => {
				await s.db.batch(extra);
				return { status: 'deferred', reason: 'fold failed' };
			}
		};
		const deps = { ...s.deps, gate: committing };
		const ada = await s.account('Ada');
		const r = await createUpload(deps, ada, input({ image: PNG }));
		expect(r).toMatchObject({ ok: true, state: 'live' });
		const e = await editUpload(deps, ada, r.ok ? r.printId : '', input({ title: 'Edited', image: PNG2 }));
		expect(e).toMatchObject({ ok: true, state: 'live' });
		expect(s.rows().map((row) => [row.state, row.title])).toEqual([['live', 'Edited']]);
		expect(s.sqlite.query(`SELECT uploads, edits, images FROM upload_quota`).get()).toEqual({ uploads: 1, edits: 1, images: 2 });
	});
	test('a screenshot approved before (the same bytes) shows at once', async () => {
		const s = await setup();
		const ada = await s.account('Ada');
		const id = (await sha256Hex(PNG)).slice(0, 16);
		s.sqlite
			.query(`INSERT INTO upload_images (id, sha256, ext, bytes, user_id, status, created_at) VALUES (?, ?, 'png', 12, ?, 'approved', 0)`)
			.run(id, await sha256Hex(PNG), ada.id);
		await createUpload(s.deps, ada, input({ image: PNG }));
		expect(s.calls.admit[0].image).toEqual({ key: `upload.${id}`, url: '' });
		// And an edit "replacing" it with the same file keeps it shown.
		const r = await createUpload(s.deps, ada, input({ title: 'Second' }));
		await editUpload(s.deps, ada, r.ok ? r.printId : '', input({ title: 'Second', image: PNG }));
		expect(s.calls.admit.at(-1)?.image).toEqual({ key: `upload.${id}`, url: '' });
	});
	test(`the sync gives up on a processing upload after ${PROCESSING_ATTEMPTS} failures, and its owner sees why`, async () => {
		let next: GateOutcome = { status: 'too-big', by: 'string', size: 1, limit: 0 };
		const s = await setup(() => next);
		const ada = await s.account('Ada');
		const r = await createUpload(s.deps, ada, input());
		const id = r.ok ? r.printId : '';
		next = { status: 'deferred', reason: 'D1 is down' };
		const outcomes = [];
		for (let i = 0; i < PROCESSING_ATTEMPTS; i++) outcomes.push((await admitProcessing(s.deps, id)).outcome);
		expect(outcomes).toEqual([...Array(PROCESSING_ATTEMPTS - 1).fill('failed'), 'gave-up']);
		expect(s.rows().map((row) => [row.state, row.attempts, row.failure])).toEqual([['failed', PROCESSING_ATTEMPTS, 'D1 is down']]);
		expect(await processingUploads(s.db)).toEqual([]);
		// An edit starts again.
		next = admitted;
		await editUpload(s.deps, ada, id, input({ title: 'Again' }));
		expect(s.rows().map((row) => [row.state, row.attempts, row.failure])).toEqual([['live', 0, null]]);
	});
});

describe('the admin queue of screenshots', () => {
	const pngId = async () => (await sha256Hex(PNG)).slice(0, 16);
	const status = (s: Awaited<ReturnType<typeof setup>>, id: string) =>
		(s.sqlite.query(`SELECT status, decided_at FROM upload_images WHERE id = ?`).get(id) as {
			status: string;
			decided_at: number | null;
		} | null) ?? null;

	test('pending images are listed oldest first, with their uploads and uploader', async () => {
		const s = await setup();
		const ada = await s.account('Ada');
		const r = await createUpload(s.deps, ada, input({ image: PNG }));
		await createUpload({ ...s.deps, now: 2_000_000 }, ada, input({ title: 'No screenshot', blueprintString: `${STRING} ` }));
		const { images, total } = await pendingImages(s.db);
		expect(total).toBe(1);
		expect(images).toEqual([
			{
				id: await pngId(),
				ext: 'png',
				bytes: PNG.byteLength,
				created_at: 1_000_000,
				user_id: ada.id,
				user_name: 'Ada',
				uploads: [{ print_id: r.ok ? r.printId : '', title: 'Red science', state: 'live', shown_name: 'Ada' }]
			}
		]);
	});

	test('approve: the record names the image, a live upload is ingested again through the gate, then the status and a page-cache bump', async () => {
		const s = await setup();
		const ada = await s.account('Ada');
		const r = await createUpload(s.deps, ada, input({ image: PNG }));
		const printId = r.ok ? r.printId : '';
		const id = await pngId();
		expect((await readRecord(s.raw.bucket, printId))?.image).toBeNull();
		const before = s.calls.admit.length;
		expect(await approveImage({ ...s.deps, now: 3_000_000 }, id)).toEqual({ ok: true, status: 'approved', uploads: 1, shown: 1 });
		expect(s.calls.admit.length).toBe(before + 1);
		expect(s.calls.admit.at(-1)?.image).toEqual({ key: `upload.${id}`, url: '' });
		expect((await readRecord(s.raw.bucket, printId))?.image).toEqual({ key: `upload.${id}`, url: '' });
		expect(status(s, id)).toEqual({ status: 'approved', decided_at: 3_000_000 });
		expect(s.sqlite.query(`SELECT value FROM meta WHERE key = 'sync_version'`).get()).toEqual({ value: '3000000' });
		// The original stays in RAW for the screenshots step; approving again changes nothing.
		expect(s.raw.objects.has(imageKey(id, 'png'))).toBe(true);
		expect(await approveImage({ ...s.deps, now: 4_000_000 }, id)).toMatchObject({ ok: true });
		expect(status(s, id)).toEqual({ status: 'approved', decided_at: 3_000_000 });
		// An edit that keeps it keeps it in the record.
		await editUpload({ ...s.deps, now: 5_000_000 }, ada, printId, input({ title: 'Kept', image: 'keep' }));
		expect((await readRecord(s.raw.bucket, printId))?.image).toEqual({ key: `upload.${id}`, url: '' });
		expect((await pendingImages(s.db)).images).toEqual([]);
	});

	test('approve: a processing upload gets it in its record for the sync, without an ingest', async () => {
		const s = await setup(() => ({ status: 'too-big', by: 'string', size: 2, limit: 1 }));
		const ada = await s.account('Ada');
		const r = await createUpload(s.deps, ada, input({ image: PNG }));
		const printId = r.ok ? r.printId : '';
		expect(r).toMatchObject({ ok: true, state: 'processing' });
		const before = s.calls.admit.length;
		expect(await approveImage(s.deps, await pngId())).toEqual({ ok: true, status: 'approved', uploads: 1, shown: 0 });
		expect(s.calls.admit.length).toBe(before);
		expect((await readRecord(s.raw.bucket, printId))?.image?.key).toBe(`upload.${await pngId()}`);
	});

	test('approve that the gate can’t finish stays pending, and approving again finishes it', async () => {
		let answer: GateOutcome = admitted;
		const s = await setup(() => answer);
		const ada = await s.account('Ada');
		await createUpload(s.deps, ada, input({ image: PNG }));
		const id = await pngId();
		answer = { status: 'deferred', reason: 'R2 down' };
		const stopped = await approveImage(s.deps, id);
		expect(stopped.ok ? '' : stopped.problem).toContain('deferred (R2 down)');
		expect(status(s, id)?.status).toBe('pending');
		answer = admitted;
		expect(await approveImage(s.deps, id)).toMatchObject({ ok: true, shown: 1 });
		expect(status(s, id)?.status).toBe('approved');
	});

	test('reject: rejected, blocked, its original deleted; its owner sees it, can replace it, and can’t send the same bytes again', async () => {
		const s = await setup();
		const ada = await s.account('Ada');
		const r = await createUpload(s.deps, ada, input({ image: PNG }));
		const printId = r.ok ? r.printId : '';
		const id = await pngId();
		const before = s.calls.admit.length;
		expect(await rejectImage({ ...s.deps, now: 3_000_000 }, id)).toEqual({ ok: true, status: 'rejected', uploads: 1, shown: 0 });
		expect(s.calls.admit.length).toBe(before);
		expect(status(s, id)).toEqual({ status: 'rejected', decided_at: 3_000_000 });
		expect(s.raw.objects.has(imageKey(id, 'png'))).toBe(false);
		expect(s.sqlite.query(`SELECT kind, value, print_id, report_id FROM removal_blocks`).all()).toEqual([
			{ kind: 'image', value: `upload.${id}`, print_id: printId, report_id: null }
		]);
		expect((await listUploads(s.db, ada.id))[0]).toMatchObject({ image_id: id, image_status: 'rejected' });
		// Never approved afterwards, and the same bytes are refused.
		expect(await approveImage(s.deps, id)).toMatchObject({ ok: false });
		expect(await createUpload(s.deps, ada, input({ title: 'Again', blueprintString: `${STRING} `, image: PNG }))).toMatchObject({
			ok: false,
			problem: 'That screenshot can’t be used.'
		});
		// Replacing it: a new pending image; the rejected row goes, its block stays.
		expect(await editUpload({ ...s.deps, now: 4_000_000 }, ada, printId, input({ image: PNG2 }))).toMatchObject({ ok: true });
		const id2 = (await sha256Hex(PNG2)).slice(0, 16);
		expect(s.images()).toMatchObject([{ id: id2, status: 'pending' }]);
		expect(s.sqlite.query(`SELECT count(*) AS n FROM removal_blocks`).get()).toEqual({ n: 1 });
		// An approved image can't be rejected here.
		await approveImage(s.deps, id2);
		expect(await rejectImage(s.deps, id2)).toMatchObject({ ok: false });
	});
});
