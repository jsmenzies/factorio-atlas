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
			cover: [],
			remove: ['d'],
			tag: [2],
			untag: [3]
		});
	});

	test('a page count change rewrites only the row', () => {
		const plan = planRenderFlags(new Map([['a', 3]]), state([['a', 2]], [[1, 'a', 1]]));
		expect(plan).toEqual({ upsert: [['a', 3]], cover: [], remove: [], tag: [], untag: [] });
	});

	test('zero pages counts as no render', () => {
		const plan = planRenderFlags(new Map([['a', 0]]), state([['a', 2]], [[1, 'a', 1]]));
		expect(plan).toEqual({ upsert: [], cover: [], remove: ['a'], tag: [], untag: [1] });
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
		expect(plan).toEqual({ upsert: [], cover: [], remove: [], tag: [1], untag: [2] });
	});

	test('in sync: nothing to do', () => {
		expect(planSize(planRenderFlags(new Map([['a', 1]]), state([['a', 1]], [[1, 'a', 1]])))).toBe(0);
	});

	test('covers: set, changed and cleared for flagged prints only; left alone without a map', () => {
		const c1 = { page: '0', stamp: '0123456789', w: 2000, h: 1000 };
		const c2 = { ...c1, stamp: 'abcdef0123' };
		const s = {
			...state(
				[
					['a', 1],
					['b', 1],
					['c', 1]
				],
				[]
			),
			covers: new Map([
				['b', c1],
				['c', c1]
			])
		};
		const wanted = new Map([
			['a', 1],
			['b', 1],
			['c', 1],
			['d', 1]
		]);
		const covers = new Map([
			['a', c1],
			['b', c1],
			['d', c2],
			['gone', c1]
		]);
		expect(planRenderFlags(wanted, s, covers).cover).toEqual([
			['a', c1],
			['c', null],
			['d', c2]
		]);
		expect(planRenderFlags(wanted, s).cover).toEqual([]);
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
			cover: [],
			remove: ids,
			tag: ids.map((_, i) => i),
			untag: ids.map((_, i) => i)
		});
		expect(Math.max(...binds)).toBeLessThan(100);
		expect(stmts.length).toBe(Math.ceil(5000 / 33) + 3 * Math.ceil(5000 / 99));
	});
});
