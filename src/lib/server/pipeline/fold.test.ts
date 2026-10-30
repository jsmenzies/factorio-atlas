import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { d1FromSqlite } from './d1-sqlite';
import { clearFoldDirty, FOLD_VERSION, foldGroup, isFoldDirty, markFoldDirty } from './fold';

const ROOT = join(import.meta.dirname, '../../../..');

describe('foldGroup', () => {
	test('the earliest posted is the original and every later copy points at it, whoever posted it', () => {
		const g = foldGroup([
			{ id: 'c', posted: 300 },
			{ id: 'a', posted: 100 },
			{ id: 'b', posted: 200 }
		]);
		expect(Object.fromEntries(g)).toEqual({
			a: { duplicateOf: null, identicalTo: null },
			b: { duplicateOf: 'a', identicalTo: null },
			c: { duplicateOf: 'a', identicalTo: null }
		});
	});

	test('a tie on posting time goes to the smaller id; no posting time sorts last', () => {
		const g = foldGroup([
			{ id: '-B', posted: 100 },
			{ id: '-A', posted: 100 },
			{ id: '-0', posted: null }
		]);
		expect(Object.fromEntries(g)).toEqual({
			'-A': { duplicateOf: null, identicalTo: null },
			'-B': { duplicateOf: '-A', identicalTo: null },
			'-0': { duplicateOf: '-A', identicalTo: null }
		});
		expect(
			Object.fromEntries(
				foldGroup([
					{ id: 'x', posted: null },
					{ id: 'w', posted: null }
				])
			)
		).toEqual({
			w: { duplicateOf: null, identicalTo: null },
			x: { duplicateOf: 'w', identicalTo: null }
		});
	});

	test('a group of one, or none, folds nothing', () => {
		expect(Object.fromEntries(foldGroup([{ id: 'a', posted: 1 }]))).toEqual({ a: { duplicateOf: null, identicalTo: null } });
		expect(foldGroup([]).size).toBe(0);
	});
});

describe('the fold flag', () => {
	const setup = () => {
		const sqlite = new Database(':memory:');
		for (const f of readdirSync(join(ROOT, 'migrations'))
			.filter((f) => f.endsWith('.sql'))
			.sort())
			sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
		return { sqlite, db: d1FromSqlite(sqlite) };
	};

	test('dirty until a full refold has run under this FOLD_VERSION; a backfill’s mark or another version makes it dirty again', async () => {
		const { sqlite, db } = setup();
		expect(await isFoldDirty(db)).toBe(true);
		await clearFoldDirty(db);
		expect(await isFoldDirty(db)).toBe(false);
		expect(sqlite.query("SELECT value FROM meta WHERE key = 'fold_version'").get()).toEqual({ value: String(FOLD_VERSION) });
		await markFoldDirty(db);
		expect(await isFoldDirty(db)).toBe(true);
		await clearFoldDirty(db);
		expect(await isFoldDirty(db)).toBe(false);
		sqlite.run("UPDATE meta SET value = '1' WHERE key = 'fold_version'");
		expect(await isFoldDirty(db)).toBe(true);
	});
});
