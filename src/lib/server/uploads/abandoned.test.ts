import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { dailyJobs, type ViewsCronEnv } from '../../../cron/views';
import { markDeleting, signInAccount } from '../auth/users';
import { d1FromSqlite } from '../pipeline/d1-sqlite';
import { CRON_DELETE_MAX_UPLOADS, DELETION_GRACE_MS, finishAbandonedDeletions } from './abandoned';
import { workerGate } from './gate';
import { createUpload, recordKey, siteIdOf } from './uploads';

/** The cron's side of account deletions, through the real gate and purge on the real migrations. */

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const NOW = 2_000_000_000_000;
const HOUR = 3_600_000;

/** A 2.0 blueprint of `n` iron chests in a row: a different print for each `n`. */
const chests = (n: number) =>
	'0' +
	deflateSync(
		JSON.stringify({
			blueprint: {
				item: 'blueprint',
				label: `Chests ${n}`,
				version: 562949954076673,
				entities: Array.from({ length: n }, (_, i) => ({ entity_number: i + 1, name: 'iron-chest', position: { x: i + 0.5, y: 0.5 } }))
			}
		})
	).toString('base64');

/** Enough of R2 for uploads, the pipeline and the purge. */
const bucket = () => {
	const objects = new Map<string, string | Uint8Array>();
	const text = (v: string | Uint8Array) => (typeof v === 'string' ? v : new TextDecoder().decode(v));
	return Object.assign(
		{
			get: async (k: string) => {
				const v = objects.get(k);
				return v === undefined ? null : { text: async () => text(v), json: async () => JSON.parse(text(v)) };
			},
			head: async (k: string) => (objects.has(k) ? {} : null),
			put: async (k: string, v: string | Uint8Array) => void objects.set(k, v),
			delete: async (keys: string | string[]) => {
				for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
			},
			list: async ({ prefix = '' }: R2ListOptions = {}) => ({
				objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
				truncated: false
			})
		} as unknown as R2Bucket,
		{ objects }
	);
};

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const setup = () => {
	const sqlite = new Database(':memory:');
	for (const f of readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.sort())
		sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
	const db = d1FromSqlite(sqlite);
	const RAW = bucket();
	const env: ViewsCronEnv = {
		DB: db,
		RAW,
		RENDERS: bucket(),
		SCREENSHOTS: bucket(),
		RENDERS_URL: '',
		SCREENSHOTS_URL: '',
		MIRROR_BASE_URL: 'https://mirror.test',
		FIREBASE_BASE_URL: 'https://firebase.test',
		ANALYTICS_API_TOKEN: 'token',
		ACCOUNT_ID: 'account',
		VIEWS_DATASET: 'views'
	};
	const deps = { db, raw: RAW, gate: workerGate(env) };
	let next = 1;
	/** An account with `uploads` live uploads, its deletion started at `deletingAt` (null: not deleting). */
	const account = async (name: string, uploads: number, deletingAt: number | null) => {
		const r = await signInAccount(db, 'dev', { subject: name.toLowerCase(), name });
		if (!r.ok) throw new Error('banned');
		const printIds: string[] = [];
		for (let i = 0; i < uploads; i++) {
			const u = await createUpload({ ...deps, origin: 'https://example.com', now: NOW - 30 * 86_400_000 + next }, r.account, {
				title: `${name} ${i}`,
				description: '',
				blueprintString: chests(next++),
				image: null
			});
			if (!u.ok || u.state !== 'live') throw new Error(`upload refused: ${JSON.stringify(u)}`);
			printIds.push(u.printId);
		}
		if (deletingAt !== null) await markDeleting(db, r.account.id, deletingAt);
		return { id: r.account.id, printIds };
	};
	const count = (sql: string, ...args: string[]) => (sqlite.query(sql).get(...args) as { n: number }).n;
	const exists = (userId: string) => count('SELECT count(*) AS n FROM users WHERE id = ?', userId) === 1;
	const live = (printId: string) => count('SELECT count(*) AS n FROM prints WHERE id = ?', printId) === 1;
	return { sqlite, db, env, RAW, deps, account, count, exists, live };
};

describe('finishAbandonedDeletions', () => {
	test('finishes deletions older than the grace, and leaves newer ones and other accounts alone', async () => {
		const s = setup();
		const old = await s.account('Ada', 2, NOW - 2 * DELETION_GRACE_MS);
		const recent = await s.account('Bob', 1, NOW - DELETION_GRACE_MS / 2);
		const keeps = await s.account('Cy', 1, null);
		expect(await finishAbandonedDeletions(s.deps, { now: NOW })).toEqual({ due: 1, finished: 1, uploads: 2, left: 0, failed: 0 });
		// Ada's account and uploads went the owner's way: prints purged with a 'gone' tombstone, records deleted.
		expect(s.exists(old.id)).toBe(false);
		for (const p of old.printIds) {
			expect(s.live(p)).toBe(false);
			expect(s.count(`SELECT count(*) AS n FROM print_tombstones WHERE print_id = ? AND kind = 'gone'`, p)).toBe(1);
			expect(s.RAW.objects.has(recordKey(siteIdOf(p)))).toBe(false);
		}
		expect(s.count('SELECT count(*) AS n FROM sessions WHERE user_id = ?', old.id)).toBe(0);
		// Bob's page may still be at it; Cy isn't deleting.
		expect(s.exists(recent.id) && s.live(recent.printIds[0])).toBe(true);
		expect(s.exists(keeps.id) && s.live(keeps.printIds[0])).toBe(true);
		// Nothing left to do.
		expect(await finishAbandonedDeletions(s.deps, { now: NOW })).toEqual({ due: 0, finished: 0, uploads: 0, left: 0, failed: 0 });
	});

	test('an account whose uploads all went but not the account itself is finished too', async () => {
		const s = setup();
		const a = await s.account('Ada', 0, NOW - 2 * HOUR);
		expect(await finishAbandonedDeletions(s.deps, { now: NOW })).toMatchObject({ due: 1, finished: 1, uploads: 0 });
		expect(s.exists(a.id)).toBe(false);
	});

	test('a run tries at most maxUploads, oldest deletion first, and the next run carries on', async () => {
		const s = setup();
		const ada = await s.account('Ada', 3, NOW - 3 * HOUR);
		const bob = await s.account('Bob', 2, NOW - 2 * HOUR);
		const cy = await s.account('Cy', 0, NOW - 2 * HOUR);
		expect(await finishAbandonedDeletions(s.deps, { now: NOW, maxUploads: 4 })).toEqual({
			due: 3,
			finished: 2,
			uploads: 4,
			left: 1,
			failed: 0
		});
		// Ada first and whole, then one of Bob's, then Cy, who costs no uploads.
		expect([s.exists(ada.id), s.exists(bob.id), s.exists(cy.id)]).toEqual([false, true, false]);
		expect(bob.printIds.map(s.live)).toEqual([false, true]);
		expect(await finishAbandonedDeletions(s.deps, { now: NOW, maxUploads: 4 })).toEqual({
			due: 1,
			finished: 1,
			uploads: 1,
			left: 0,
			failed: 0
		});
		expect(s.exists(bob.id)).toBe(false);
	});

	test('a run stops when its time is up', async () => {
		const s = setup();
		const ada = await s.account('Ada', 3, NOW - 3 * HOUR);
		const bob = await s.account('Bob', 1, NOW - 2 * HOUR);
		// A clock that runs out after one upload.
		let t = 0;
		const clock = () => (t += 10);
		expect(await finishAbandonedDeletions(s.deps, { now: NOW, budgetMs: 25, clock })).toEqual({
			due: 2,
			finished: 0,
			uploads: 1,
			left: 2,
			failed: 0
		});
		expect(ada.printIds.map(s.live)).toEqual([false, true, true]);
		expect(s.live(bob.printIds[0])).toBe(true);
	});

	test('one account that fails is left for the next run, and the others go on', async () => {
		const s = setup();
		const ada = await s.account('Ada', 1, NOW - 3 * HOUR);
		const bob = await s.account('Bob', 1, NOW - 2 * HOUR);
		// Ada's step fails at its first write (deleteAccountStep marks the account first).
		const db = new Proxy(s.db, {
			get: (target, key) =>
				key === 'prepare'
					? (sql: string) => {
							const stmt = target.prepare(sql);
							if (!sql.includes('coalesce(deleting_at')) return stmt;
							return new Proxy(stmt, {
								get: (st, k) =>
									k === 'bind'
										? (...args: unknown[]) =>
												args.includes(ada.id) ? { run: () => Promise.reject(new Error('D1 went away')) } : st.bind(...args)
										: Reflect.get(st, k)
							});
						}
					: Reflect.get(target, key)
		});
		expect(await finishAbandonedDeletions({ ...s.deps, db }, { now: NOW })).toEqual({
			due: 2,
			finished: 1,
			uploads: 1,
			left: 1,
			failed: 1
		});
		expect([s.exists(ada.id), s.live(ada.printIds[0]), s.exists(bob.id)]).toEqual([true, true, false]);
		expect(await finishAbandonedDeletions(s.deps, { now: NOW })).toMatchObject({ finished: 1, failed: 0 });
		expect(s.exists(ada.id)).toBe(false);
	});

	test('the default bound fits a cron invocation’s 10,000 subrequests at about 20 an upload', () => {
		expect(CRON_DELETE_MAX_UPLOADS * 20).toBeLessThan(5_000);
	});
});

describe('the daily cron', () => {
	/** The Analytics Engine SQL API answering `views` per print, or failing. */
	const analytics = (answer: { views: Record<string, number> } | { status: number }) => {
		globalThis.fetch = (async () =>
			'status' in answer
				? new Response('no', { status: answer.status })
				: Response.json({ data: Object.entries(answer.views).map(([id, n]) => ({ id, views: n })) })) as unknown as typeof fetch;
	};

	test('runs the views rollup and finishes abandoned deletions', async () => {
		const s = setup();
		const keeps = await s.account('Cy', 1, null);
		const gone = await s.account('Ada', 1, Date.now() - 2 * DELETION_GRACE_MS);
		analytics({ views: { [keeps.printIds[0]]: 7 } });
		await dailyJobs(s.env);
		expect(s.count('SELECT views_30d AS n FROM prints WHERE id = ?', keeps.printIds[0])).toBe(7);
		expect([s.exists(gone.id), s.live(gone.printIds[0])]).toEqual([false, false]);
	});

	test('a failed views rollup doesn’t stop the deletions, and the run still fails', async () => {
		const s = setup();
		const gone = await s.account('Ada', 1, Date.now() - 2 * DELETION_GRACE_MS);
		analytics({ status: 500 });
		await expect(dailyJobs(s.env)).rejects.toThrow('daily jobs failed: views');
		expect(s.exists(gone.id)).toBe(false);
	});

	test('failed deletions don’t stop the views rollup, and the run still fails', async () => {
		const s = setup();
		const keeps = await s.account('Cy', 1, null);
		analytics({ views: { [keeps.printIds[0]]: 3 } });
		// The deletions' first read fails.
		const db = new Proxy(s.db, {
			get: (target, key) =>
				key === 'prepare'
					? (sql: string) => {
							if (sql.includes('a.deleting_at <= ?')) throw new Error('D1 went away');
							return target.prepare(sql);
						}
					: Reflect.get(target, key)
		});
		await expect(dailyJobs({ ...s.env, DB: db })).rejects.toThrow('daily jobs failed: deletions');
		expect(s.count('SELECT views_30d AS n FROM prints WHERE id = ?', keeps.printIds[0])).toBe(3);
	});
});
