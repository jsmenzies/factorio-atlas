import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { d1FromSqlite } from './pipeline/d1-sqlite';
import { insertBlocks, isPrintRemoved, loadBlocks, loadRemovedPrintIds, printBlocks, sourceBlock, type BlockRow } from './removal-blocks';

const ROOT = join(import.meta.dirname, '../../..');

const migrated = () => {
	const sqlite = new Database(':memory:');
	for (const f of readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.sort()) {
		sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
	}
	return d1FromSqlite(sqlite);
};

const row = (b: { kind: BlockRow['kind']; value: string }, printId = 'p'): BlockRow => ({
	...b,
	print_id: printId,
	report_id: null,
	created_at: 1
});

describe('removal blocks', () => {
	test('a print is removed by its own id or its factorioprints source id', async () => {
		const db = migrated();
		expect(await isPrintRemoved(db, '-A')).toBe(false);
		await db.batch(insertBlocks(db, [row({ kind: 'print', value: '-A' })]));
		await db.batch(insertBlocks(db, [row(sourceBlock('factorioprints', '-B'))]));
		await db.batch(insertBlocks(db, [row(sourceBlock('fbin', '-C'))]));
		expect(await isPrintRemoved(db, '-A')).toBe(true);
		expect(await isPrintRemoved(db, '-B')).toBe(true);
		// Another site's id is not a factorioprints id.
		expect(await isPrintRemoved(db, '-C')).toBe(false);
		expect([...(await loadRemovedPrintIds(db))].sort()).toEqual(['-A', '-B']);
	});

	test('inserting the same blocks twice keeps one row each', async () => {
		const db = migrated();
		const rows = printBlocks('-A').map((b) => row(b, '-A'));
		await db.batch(insertBlocks(db, rows));
		await db.batch(insertBlocks(db, rows));
		expect((await loadBlocks(db)).map((b) => `${b.kind} ${b.value}`)).toEqual(['print -A', 'source factorioprints:-A']);
	});
});
