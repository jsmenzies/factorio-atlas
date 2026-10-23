import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cardImage } from '#lib/screenshots.js';
import { d1FromSqlite } from './pipeline/d1-sqlite';
import { planShotFlags, removalStatements, syncScreenshotFlags, type ShotRow } from './screenshot-flags';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const copied = (w: number): ShotRow => ({ state: 'copied', v: 1, ext: 'png', w, h: 100 });

/** The real migrations on an in-memory database. */
const fresh = () => {
	const sqlite = new Database(':memory:');
	for (const f of readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.sort())
		sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
	return { sqlite, db: d1FromSqlite(sqlite) };
};

describe('planShotFlags', () => {
	test('sets new and changed rows in every state, deletes rows no manifest names, keeps removals removed', () => {
		const plan = planShotFlags(
			new Map<string, ShotRow>([
				['a', copied(1)],
				['b', copied(2)],
				['c', { state: 'dead' }],
				['r', copied(4)]
			]),
			new Map<string, ShotRow>([
				['a', copied(1)],
				['b', copied(9)],
				['d', copied(5)],
				['g', { state: 'removed' }]
			]),
			new Set(['r', 'x'])
		);
		expect(plan).toEqual({
			upsert: [
				['b', copied(2)],
				['c', { state: 'dead' }],
				['r', { state: 'removed' }],
				['x', { state: 'removed' }]
			],
			remove: ['d', 'g']
		});
	});
});

test('syncScreenshotFlags on the real schema: writes the difference, purges the page cache, then writes nothing', async () => {
	const { sqlite, db } = fresh();
	const wanted = new Map<string, ShotRow>(Array.from({ length: 40 }, (_, i) => [`img${i}`, copied(i + 1)] as [string, ShotRow]));
	wanted.set('dead1', { state: 'dead' });
	const first = await syncScreenshotFlags(db, wanted, { now: 5 });
	expect(first.plan.upsert.length).toBe(41);
	expect(sqlite.query('SELECT state, COUNT(*) AS n FROM screenshots GROUP BY state ORDER BY state').all()).toEqual([
		{ state: 'copied', n: 40 },
		{ state: 'dead', n: 1 }
	]);
	expect(sqlite.query(`SELECT v, ext, w, h FROM screenshots WHERE image_id = 'dead1'`).get()).toEqual({
		v: null,
		ext: null,
		w: null,
		h: null
	});
	expect(sqlite.query(`SELECT value FROM meta WHERE key = 'sync_version'`).get()).not.toBeNull();
	const again = await syncScreenshotFlags(db, wanted);
	expect(again.plan).toEqual({ upsert: [], remove: [] });
	expect(again.rowsWritten).toBe(0);
	wanted.delete('img3');
	expect((await syncScreenshotFlags(db, wanted)).plan.remove).toEqual(['img3']);
});

test('a removal of an image with no row yet leaves a removed row, so the card shows no Imgur copy, and flags keeps it', async () => {
	const { sqlite, db } = fresh();
	await db.batch(removalStatements(db, 'NoRow12', '-AAAAAAAAAAAAAAAAAAA', 'request', 7));
	const row = sqlite.query(`SELECT state, v FROM screenshots WHERE image_id = 'NoRow12'`).get() as { state: string; v: number | null };
	expect(row).toEqual({ state: 'removed', v: null });
	expect(sqlite.query(`SELECT value FROM meta WHERE key = 'sync_version'`).get()).toEqual({ value: '7' });
	const columns = {
		id: '-AAAAAAAAAAAAAAAAAAA',
		image_id: 'NoRow12',
		image_type: 'image/png',
		shot_state: row.state,
		shot_v: null,
		shot_ext: null,
		shot_w: null,
		shot_h: null,
		cover_page: null,
		cover_stamp: null,
		cover_w: null,
		cover_h: null
	};
	expect(cardImage(columns, { shots: '', renderBase: () => '' })).toBeNull();
	// Without the row, the same card would show Imgur's copy.
	expect(cardImage({ ...columns, shot_state: null }, { shots: '', renderBase: () => '' })?.kind).toBe('imgur');
	// No upload ever named it: flags keeps it removed rather than deleting the row.
	const sync = await syncScreenshotFlags(db, new Map());
	expect(sync.plan).toEqual({ upsert: [], remove: [] });
	expect(sqlite.query(`SELECT state FROM screenshots WHERE image_id = 'NoRow12'`).get()).toEqual({ state: 'removed' });
});
