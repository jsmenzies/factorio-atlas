import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPEN_PER_SUBJECT_MAX, PURGE_ONLY } from '#lib/reports.js';
import { d1FromSqlite } from './pipeline/d1-sqlite';
import { isPrintRemoved } from './removal-blocks';
import { applyTakedown, clearOldReportText, createReport, createRemovalRequest, decide, markPurgedByHand, reportQueue } from './reports';
import type { TakedownEnv } from './takedown';

const ROOT = join(import.meta.dirname, '../../..');

/** Migrated D1 with one bare print row, and empty buckets. */
const setup = () => {
	const sqlite = new Database(':memory:');
	for (const f of readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.sort()) {
		sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
	}
	const columns = sqlite.query('PRAGMA table_info(prints)').all() as { name: string; notnull: number; dflt_value: unknown }[];
	const required = columns.filter((c) => c.name === 'id' || (c.notnull && c.dflt_value === null));
	sqlite
		.query(`INSERT INTO prints (${required.map((c) => c.name).join(', ')}) VALUES (${required.map(() => '?').join(', ')})`)
		.run(...required.map((c) => (c.name === 'id' ? '-A' : c.name === 'title' ? 'A print' : 0)));
	const db = d1FromSqlite(sqlite);
	const bucket = {
		list: async () => ({ objects: [], truncated: false }),
		delete: async () => {},
		put: async () => {}
	} as unknown as R2Bucket;
	const env: TakedownEnv = { DB: db, RAW: bucket, RENDERS: bucket, SCREENSHOTS: bucket, RENDERS_URL: '', SCREENSHOTS_URL: '' };
	return { sqlite, db, env };
};

const request = { printId: '-A', reason: 'author' as const, details: 'mine', contact: 'me@example.com', reporterUserId: null };

describe('removal requests', () => {
	test('stored per request, capped per print, refused for a print not on the site', async () => {
		const { db } = setup();
		expect(await createRemovalRequest(db, request)).toBe('stored');
		expect(await createRemovalRequest(db, { ...request, printId: '-Nope' })).toBe('missing');
		for (let i = 1; i < OPEN_PER_SUBJECT_MAX; i++) await createRemovalRequest(db, request);
		expect(await createRemovalRequest(db, request)).toBe('capped');
		const { open } = await reportQueue(db);
		expect(open.length).toBe(1);
		expect(open[0].print?.title).toBe('A print');
		expect(open[0].requests.length).toBe(OPEN_PER_SUBJECT_MAX);
	});

	test('reject records the decision and leaves the print', async () => {
		const { db, env } = setup();
		await createRemovalRequest(db, request);
		const r = await decide(env, { subjectKind: 'print', subjectId: '-A', approve: false, note: 'not theirs', by: 'dev' });
		expect(r).toEqual({ decided: 1, takedown: null });
		const { open, decided } = await reportQueue(db);
		expect(open).toEqual([]);
		expect(decided.map((d) => [d.status, d.note, d.decided_by])).toEqual([['rejected', 'not theirs', 'dev']]);
		expect(await isPrintRemoved(db, '-A')).toBe(false);
	});

	test('approve takes the print down and marks every open request applied', async () => {
		const { db, env, sqlite } = setup();
		await createRemovalRequest(db, request);
		await createRemovalRequest(db, { ...request, reason: 'other' as never });
		const r = await decide(env, { subjectKind: 'print', subjectId: '-A', approve: true, note: null, by: 'admin@example.com' });
		expect(r.decided).toBe(2);
		expect(await isPrintRemoved(db, '-A')).toBe(true);
		expect(sqlite.query('SELECT count(*) AS n FROM prints').get()).toEqual({ n: 0 });
		expect(sqlite.query(`SELECT count(*) AS n FROM reports WHERE status = 'approved' AND applied_at IS NOT NULL`).get()).toEqual({ n: 2 });
		const blocks = sqlite.query('SELECT report_id FROM removal_blocks').all() as { report_id: string }[];
		expect(blocks.every((b) => b.report_id)).toBe(true);
	});

	test('contacts and details are cleared 30 days after the decision, not before', async () => {
		const { db, env, sqlite } = setup();
		await createRemovalRequest(db, request);
		const day = 86_400_000;
		await decide(env, { subjectKind: 'print', subjectId: '-A', approve: false, note: null, by: 'dev', now: 0 });
		await clearOldReportText(db, 29 * day);
		expect(sqlite.query('SELECT contact, details FROM reports').get()).toEqual({ contact: 'me@example.com', details: 'mine' });
		await clearOldReportText(db, 31 * day);
		expect(sqlite.query('SELECT contact, details, reason FROM reports').get()).toEqual({ contact: null, details: null, reason: 'author' });
	});

	test('the queue is generic: reports about an image or an account group by subject and are capped per subject', async () => {
		const { db, env } = setup();
		const about = {
			kind: 'report',
			subjectKind: 'image' as const,
			subjectId: 'Img1234',
			printId: '-A',
			reason: 'nsfw',
			details: null,
			contact: null,
			reporterUserId: 'u1'
		};
		expect(await createReport(db, about)).toBe('stored');
		expect(await createReport(db, { ...about, subjectKind: 'account', subjectId: 'u9', printId: null })).toBe('stored');
		await createRemovalRequest(db, request);
		const { open } = await reportQueue(db);
		expect(open.map((e) => [e.subjectKind, e.subjectId, e.print?.title ?? null])).toEqual([
			['image', 'Img1234', 'A print'],
			['account', 'u9', null],
			['print', '-A', 'A print']
		]);
		// Approving a report that isn't about a print records it and runs nothing here.
		expect(await decide(env, { subjectKind: 'image', subjectId: 'Img1234', approve: true, note: null, by: 'dev' })).toEqual({
			decided: 1,
			takedown: null
		});
		expect(await isPrintRemoved(db, '-A')).toBe(false);
	});
});

describe('takedowns that are not finished', () => {
	/** A stage whose renders domain is cached, so every takedown has something to purge. */
	const withDomain = (purge?: (body: string) => Response) => {
		const h = setup();
		const env = {
			...h.env,
			RENDERS_URL: 'https://renders.example.com',
			...(purge ? { CACHE_PURGE_TOKEN: 't', CACHE_ZONE_ID: 'z' } : {})
		};
		const sent: string[] = [];
		const realFetch = globalThis.fetch;
		if (purge) {
			globalThis.fetch = (async (_url: string, init: RequestInit) => {
				sent.push(String(init.body));
				return purge(String(init.body));
			}) as typeof fetch;
		}
		return { ...h, env, sent, restore: () => (globalThis.fetch = realFetch) };
	};
	const unapplied = (sqlite: Database) =>
		sqlite.query(`SELECT applied_at, pending_purge, apply_error FROM reports WHERE status = 'approved'`).get() as {
			applied_at: number | null;
			pending_purge: string | null;
			apply_error: string | null;
		};

	test('no purge token: not applied, the list is kept, and the admin can mark it purged by hand', async () => {
		const { db, env, sqlite } = withDomain();
		await createRemovalRequest(db, request);
		const r = await decide(env, { subjectKind: 'print', subjectId: '-A', approve: true, note: null, by: 'dev' });
		expect(r.takedown?.purged).toBe(false);
		const row = unapplied(sqlite);
		expect(row.applied_at).toBeNull();
		expect(JSON.parse(row.pending_purge!)).toEqual({ prefixes: ['renders.example.com/-A/'], urls: [] });
		expect(row.apply_error).toBe(`${PURGE_ONLY}no purge token on this stage`);
		await markPurgedByHand(db, '-A');
		expect(unapplied(sqlite)).toMatchObject({ pending_purge: null, apply_error: null });
		expect(unapplied(sqlite).applied_at).not.toBeNull();
	});

	test('a failed purge (e.g. 429) stays not applied; running it again purges what was kept, then it is applied', async () => {
		let fail = true;
		const h = withDomain(() => (fail ? new Response('rate limited', { status: 429 }) : Response.json({ success: true })));
		try {
			await createRemovalRequest(h.db, request);
			await decide(h.env, { subjectKind: 'print', subjectId: '-A', approve: true, note: null, by: 'dev' });
			expect(unapplied(h.sqlite).applied_at).toBeNull();
			expect(unapplied(h.sqlite).apply_error).toContain('429');
			// The kept list carries a URL the retry can no longer list (its file is gone).
			h.sqlite.run(
				`UPDATE reports SET pending_purge = '{"prefixes":["renders.example.com/-A/"],"urls":["https://shots.example.com/Gone1.png"]}'`
			);
			fail = false;
			const again = await applyTakedown(h.env, '-A', false);
			expect(again.purged).toBe(true);
			expect(h.sent.at(-1)).toContain('https://shots.example.com/Gone1.png');
			expect(unapplied(h.sqlite)).toMatchObject({ pending_purge: null, apply_error: null });
			expect(unapplied(h.sqlite).applied_at).not.toBeNull();
		} finally {
			h.restore();
		}
	});

	test('a takedown that throws records why and what to purge, and is not applied', async () => {
		const h = setup();
		const env = {
			...h.env,
			RAW: { ...h.env.RAW, delete: async () => Promise.reject(new Error('R2 is down')) } as unknown as R2Bucket
		};
		await createRemovalRequest(h.db, request);
		await expect(decide(env, { subjectKind: 'print', subjectId: '-A', approve: true, note: null, by: 'dev' })).rejects.toThrow(
			'R2 is down'
		);
		const row = unapplied(h.sqlite);
		expect(row.applied_at).toBeNull();
		expect(row.apply_error).toBe('R2 is down');
		// Not a purge-only failure, so it can't be marked purged by hand.
		await markPurgedByHand(h.db, '-A');
		expect(unapplied(h.sqlite).applied_at).toBeNull();
	});
});
