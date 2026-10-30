import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSession } from '../auth/sessions';
import { nameTaken, signInAccount, type Account } from '../auth/users';
import { d1FromSqlite } from '../pipeline/d1-sqlite';
import type { GateOutcome, PurgeExtras, UploadGate } from '../uploads/gate';
import { createUpload, type UploadInput } from '../uploads/uploads';
import { accountDetail, accountList, accountPage, accountSearch, ACCOUNTS_PAGE_SIZE, adminDeleteAccount, endSessions } from './accounts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const STRING = '0eNqrVkrKKU0tKMrMK1GyqlYqLkksKS1WsoqOrQUAhKMJmg==';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const DAY = 86_400_000;
const NOW = 100 * DAY;

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

const setup = async () => {
	const sqlite = new Database(':memory:');
	for (const f of readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.sort())
		sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
	const db = d1FromSqlite(sqlite);
	const raw = memoryBucket();
	let answer: GateOutcome = { status: 'admitted', printId: '', suggestions: [] };
	const gone: { siteId: string; extras: PurgeExtras }[] = [];
	const gate: UploadGate = {
		admit: async (_record, printId, extra) => {
			if (answer.status === 'admitted') await db.batch(extra);
			return answer.status === 'admitted' ? { ...answer, printId } : answer;
		},
		sourceGone: async (siteId, extras) => {
			gone.push({ siteId, extras });
			return 'purged';
		},
		imageBlocked: async () => false
	};
	const setAnswer = (a: GateOutcome) => void (answer = a);
	let clock = NOW;
	const account = async (name: string, at: number, provider: 'github' | 'discord' | 'dev' = 'github'): Promise<Account> => {
		const r = await signInAccount(db, provider, { subject: name, name }, at);
		if (!r.ok) throw new Error('banned');
		return r.account;
	};
	const upload = (who: Account, over: Partial<UploadInput> = {}) =>
		createUpload({ db, raw: raw.bucket, gate, origin: 'https://example.com', now: (clock += 1000) }, who, {
			title: 'Red science',
			description: '',
			blueprintString: STRING,
			image: null,
			...over
		});
	const deps = { db, raw: raw.bucket, gate };
	return { sqlite, db, raw, deps, gone, account, upload, setAnswer };
};

describe('the account list', () => {
	test('one row per account with its providers, sessions, last seen, uploads by state and pending screenshots', async () => {
		const s = await setup();
		const ada = await s.account('Ada', NOW - 30 * DAY);
		const grace = await s.account('Grace', NOW - 20 * DAY, 'discord');
		await s.account('Bob', NOW - 10 * DAY, 'dev');
		// Grace also signs in with GitHub.
		s.sqlite.query(`INSERT INTO user_identities (provider, subject, user_id, created_at) VALUES ('github', 'g', ?, ?)`).run(grace.id, NOW);

		// Ada signs in three times; the first session has expired by the second sign-in, which deletes it.
		await createSession(s.db, ada.id, NOW - 40 * DAY);
		await createSession(s.db, ada.id, NOW - 5 * DAY);
		await createSession(s.db, ada.id, NOW - 2 * DAY);

		// Ada's uploads: two live sharing one pending PNG, one live with a JPEG, one processing, one failed, one refused.
		await s.upload(ada, { image: PNG });
		await s.upload(ada, { image: PNG });
		await s.upload(ada, { image: JPEG });
		s.setAnswer({ status: 'too-big', by: 'string', size: 2, limit: 1 });
		await s.upload(ada);
		const failed = await s.upload(ada);
		const refused = await s.upload(ada);
		s.sqlite.query(`UPDATE uploads SET state = 'failed' WHERE print_id = ?`).run(failed.ok ? failed.printId : '');
		s.sqlite
			.query(`UPDATE uploads SET state = 'refused', refused_reason = 'blocked' WHERE print_id = ?`)
			.run(refused.ok ? refused.printId : '');
		// The JPEG approved: no longer pending.
		s.sqlite.run(`UPDATE upload_images SET status = 'approved' WHERE ext = 'jpg'`);

		const list = await accountList(s.db, { now: NOW });
		expect(list).toMatchObject({ total: 3, page: 1, pages: 1 });
		expect(list.accounts.map((a) => a.name)).toEqual(['Bob', 'Grace', 'Ada']);
		const [bob, g, a] = list.accounts;
		expect(a).toMatchObject({
			providers: ['GitHub'],
			createdAt: NOW - 30 * DAY,
			sessions: 2,
			lastSeen: NOW - 2 * DAY,
			uploads: { live: 3, processing: 1, refused: 1, failed: 1 },
			pendingScreenshots: 1,
			deletingAt: null,
			bannedAt: null
		});
		expect(g).toMatchObject({ providers: ['Discord', 'GitHub'], sessions: 0, lastSeen: null, pendingScreenshots: 0 });
		expect(bob).toMatchObject({ providers: ['Test sign-in'], uploads: { live: 0, processing: 0, refused: 0, failed: 0 } });
		// Nothing more than the privacy page lists: no provider subject ids.
		expect(JSON.stringify(list)).not.toContain('"g"');
		expect(Object.keys(a).sort()).toEqual(
			['bannedAt', 'createdAt', 'deletingAt', 'id', 'lastSeen', 'name', 'pendingScreenshots', 'providers', 'sessions', 'uploads'].sort()
		);
		// An expired session counts towards last seen, never as active.
		s.sqlite.query(`DELETE FROM sessions WHERE user_id = ?`).run(ada.id);
		await createSession(s.db, ada.id, NOW - 31 * DAY);
		expect((await accountList(s.db, { now: NOW })).accounts[2]).toMatchObject({ sessions: 0, lastSeen: NOW - 31 * DAY });
	});

	test('search by name contains, ignoring case; LIKE wildcards are literal', async () => {
		const s = await setup();
		await s.account('Ada Lovelace', 1);
		await s.account('lovely_one', 2);
		await s.account('Grace', 3);
		await s.account('Ad1', 4);
		expect((await accountList(s.db, { q: 'LOVE' })).accounts.map((a) => a.name)).toEqual(['lovely_one', 'Ada Lovelace']);
		expect((await accountList(s.db, { q: 'y_o' })).accounts.map((a) => a.name)).toEqual(['lovely_one']);
		expect((await accountList(s.db, { q: 'Ad_' })).total).toBe(0);
		expect((await accountList(s.db, { q: '%' })).total).toBe(0);
		expect(accountSearch('  a   b ')).toBe('a b');
		expect(accountSearch('x'.repeat(100)).length).toBe(64);
	});

	test('pages of 100, newest first, every account once', async () => {
		const s = await setup();
		const stmt = s.sqlite.query(`INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)`);
		// 250 accounts, some made in the same millisecond.
		for (let i = 0; i < 250; i++) stmt.run(`id-${String(i).padStart(3, '0')}`, `User ${i}`, Math.floor(i / 3));
		const pages = await Promise.all([1, 2, 3, 4].map((page) => accountList(s.db, { page })));
		expect(pages.map((p) => p.accounts.length)).toEqual([ACCOUNTS_PAGE_SIZE, ACCOUNTS_PAGE_SIZE, 50, 0]);
		expect(pages[0]).toMatchObject({ total: 250, pages: 3 });
		const all = pages.flatMap((p) => p.accounts);
		expect(new Set(all.map((a) => a.id)).size).toBe(250);
		expect(all.map((a) => a.createdAt)).toEqual(all.map((a) => a.createdAt).sort((x, y) => y - x));
		expect([accountPage(null), accountPage('0'), accountPage('-3'), accountPage('x'), accountPage('3')]).toEqual([1, 1, 1, 1, 3]);
	});

	test('the list reads each account’s rows by index: no table scan but users’ own, no sort', async () => {
		const s = await setup();
		const sqls: string[] = [];
		const spy = {
			prepare: (sql: string) => {
				sqls.push(sql);
				return s.db.prepare(sql);
			},
			batch: (st: D1PreparedStatement[]) => s.db.batch(st)
		} as unknown as D1Database;
		await accountList(spy, {});
		await accountDetail(spy, 'x');
		expect(sqls.length).toBe(4);
		for (const sql of sqls) {
			const n = (sql.match(/\?(\d)/g) ?? []).reduce((m, p) => Math.max(m, Number(p.slice(1))), 0) || (sql.match(/\?/g) ?? []).length;
			const plan = (s.sqlite.query(`EXPLAIN QUERY PLAN ${sql}`).all(...Array.from({ length: n }, () => 1)) as { detail: string }[]).map(
				(r) => r.detail
			);
			for (const line of plan) {
				if (line.startsWith('SCAN'))
					expect(/^SCAN (u|users) USING (COVERING )?INDEX users_created$/.test(line) ? 'users by users_created' : line).toBe(
						'users by users_created'
					);
				expect(line).not.toContain('FOR ORDER BY');
			}
		}
	});

	test('detail: the facts and the uploads, newest first; null for no such account', async () => {
		const s = await setup();
		const ada = await s.account('Ada', 1);
		const first = await s.upload(ada, { title: 'First' });
		await s.upload(ada, { title: 'Second' });
		const d = await accountDetail(s.db, ada.id, NOW);
		expect(d?.account).toMatchObject({ name: 'Ada', uploads: { live: 2 } });
		expect(d?.uploads.map((u) => u.title)).toEqual(['Second', 'First']);
		expect(d?.uploads[1].print_id).toBe(first.ok ? first.printId : '');
		expect(await accountDetail(s.db, 'nobody')).toBeNull();
	});
});

describe('admin actions', () => {
	test('sign out everywhere ends only that account’s sessions', async () => {
		const s = await setup();
		const ada = await s.account('Ada', 1);
		const grace = await s.account('Grace', 2);
		for (const id of [ada.id, ada.id, grace.id]) await createSession(s.db, id, NOW);
		expect(await endSessions(s.db, ada.id)).toBe(2);
		expect(s.sqlite.query(`SELECT user_id FROM sessions`).all()).toEqual([{ user_id: grace.id }]);
	});

	test('delete needs the exact name, then goes the owner’s way in steps; the name stays held', async () => {
		const s = await setup();
		const ada = await s.account('Ada', 1);
		const grace = await s.account('Grace', 2);
		for (let i = 0; i < 3; i++) await s.upload(ada, { image: i === 0 ? PNG : null });
		await s.upload(grace);
		await createSession(s.db, ada.id, NOW);

		expect(await adminDeleteAccount(s.deps, ada.id, 'ada')).toMatchObject({ ok: false, status: 400 });
		expect(await adminDeleteAccount(s.deps, ada.id, null)).toMatchObject({ ok: false, status: 400 });
		expect(await adminDeleteAccount(s.deps, 'nobody', 'Ada')).toMatchObject({ ok: false, status: 404 });
		expect(s.gone.length).toBe(0);

		// A clock that runs out after one upload: one step deletes one, the account stays, marked deleting.
		let t = 0;
		const clock = () => (t += 10);
		expect(await adminDeleteAccount(s.deps, ada.id, ' Ada ', { budgetMs: 15, clock })).toEqual({
			ok: true,
			name: 'Ada',
			deleted: 1,
			left: 2,
			done: false
		});
		const mid = await accountDetail(s.db, ada.id, NOW);
		expect(mid?.account.deletingAt).not.toBeNull();
		expect(mid?.account.uploads.live).toBe(2);
		// Later steps need no name (the page posts them by itself), as when the owner started it.
		expect(await adminDeleteAccount(s.deps, ada.id, null)).toEqual({ ok: true, name: 'Ada', deleted: 2, left: 0, done: true });

		expect(await accountDetail(s.db, ada.id)).toBeNull();
		expect(s.gone.length).toBe(3);
		expect(s.sqlite.query(`SELECT count(*) AS n FROM sessions`).get()).toEqual({ n: 0 });
		expect(s.sqlite.query(`SELECT user_id FROM uploads`).all()).toEqual([{ user_id: grace.id }]);
		expect(s.sqlite.query(`SELECT name FROM released_names`).all()).toEqual([{ name: 'Ada' }]);
		expect(await nameTaken(s.db, 'Ada', grace.id)).toBe(true);
		expect((await accountList(s.db)).accounts.map((a) => a.name)).toEqual(['Grace']);
	});
});
