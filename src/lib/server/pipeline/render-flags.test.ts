import { describe, expect, test } from 'bun:test';
import { planRenderFlags, planSize, renderFlagStatements } from './render-flags';

const state = (rows: [string, number][], fts: [number, string, number][]) => ({
	rows: new Map(rows),
	fts: fts.map(([rowid, print_id, flagged]) => ({ rowid, print_id, flagged }))
});

describe('planRenderFlags', () => {
	test('sets new prints, unsets gone ones, leaves the rest', () => {
		const plan = planRenderFlags(
			new Map([
				['a', 2],
				['b', 1],
				['c', 5]
			]),
			state(
				[
					['a', 2],
					['d', 1]
				],
				[
					[1, 'a', 1],
					[2, 'b', 0],
					[3, 'd', 1],
					[4, 'e', 0]
				]
			)
		);
		expect(plan).toEqual({
			upsert: [
				['b', 1],
				['c', 5]
			],
			remove: ['d'],
			tag: [2],
			untag: [3]
		});
	});

	test('a page count change rewrites only the row', () => {
		const plan = planRenderFlags(new Map([['a', 3]]), state([['a', 2]], [[1, 'a', 1]]));
		expect(plan).toEqual({ upsert: [['a', 3]], remove: [], tag: [], untag: [] });
	});

	test('zero pages counts as no render', () => {
		const plan = planRenderFlags(new Map([['a', 0]]), state([['a', 2]], [[1, 'a', 1]]));
		expect(plan).toEqual({ upsert: [], remove: ['a'], tag: [], untag: [1] });
	});

	test('repairs an FTS row that lost or kept the token by mistake', () => {
		const plan = planRenderFlags(
			new Map([['a', 1]]),
			state(
				[['a', 1]],
				[
					[1, 'a', 0],
					[2, 'z', 1]
				]
			)
		);
		expect(plan).toEqual({ upsert: [], remove: [], tag: [1], untag: [2] });
	});

	test('in sync: nothing to do', () => {
		expect(planSize(planRenderFlags(new Map([['a', 1]]), state([['a', 1]], [[1, 'a', 1]])))).toBe(0);
	});
});

describe('renderFlagStatements', () => {
	test('stays under 100 bound parameters per statement', () => {
		const binds: number[] = [];
		const db = {
			prepare: (sql: string) => ({ bind: (...args: unknown[]) => (binds.push(args.length), { sql, args }) })
		} as unknown as D1Database;
		const ids = Array.from({ length: 5000 }, (_, i) => `p${i}`);
		const stmts = renderFlagStatements(db, {
			upsert: ids.map((id) => [id, 1]),
			remove: ids,
			tag: ids.map((_, i) => i),
			untag: ids.map((_, i) => i)
		});
		expect(Math.max(...binds)).toBeLessThan(100);
		expect(stmts.length).toBe(Math.ceil(5000 / 33) + 3 * Math.ceil(5000 / 99));
	});
});
