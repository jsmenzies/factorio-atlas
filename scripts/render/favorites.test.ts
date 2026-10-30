import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { d1FromSqlite } from '#lib/server/pipeline/d1-sqlite.js';
import { checkSources, favoritesDb, planRefresh, rankFavorites, readFavorites, refreshFavorites, topIds } from './favorites.js';
import { favoriteWork, takesPrint, versionSkip, withTopFirst } from './scope.js';

const ROOT = join(import.meta.dirname, '..', '..');

/** The real migrations over bun:sqlite. */
const migrated = () => {
	const sqlite = new Database(':memory:');
	for (const f of readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.sort())
		sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
	return { sqlite, db: d1FromSqlite(sqlite) };
};

/** A folder of raw records (`<id>.json`), like data/raw/factorioprints. */
const recordsDir = (favs: Record<string, number | undefined>) => {
	const dir = mkdtempSync(join(tmpdir(), 'favs-'));
	for (const [id, n] of Object.entries(favs))
		writeFileSync(
			join(dir, `${id}.json`),
			JSON.stringify({ blueprintString: '0x', title: id, ...(n === undefined ? {} : { numberOfFavorites: n }) })
		);
	const source = {
		label: 'disk',
		ids: async () =>
			readdirSync(dir)
				.filter((f) => f.endsWith('.json'))
				.map((f) => f.slice(0, -5))
				.sort(),
		file: (id: string) => join(dir, `${id}.json`),
		stamp: async (id: string) => {
			try {
				const s = statSync(join(dir, `${id}.json`));
				return `${s.size}:${Math.round(s.mtimeMs)}`;
			} catch {
				return null;
			}
		}
	};
	return { dir, source };
};

describe('ranking favourites', () => {
	test('most favourites first, ties by id', () => {
		expect(
			rankFavorites([
				['b', 5],
				['a', 5],
				['c', 9],
				['d', 0]
			])
		).toEqual([
			{ print_id: 'c', favorites: 9, rank: 1 },
			{ print_id: 'a', favorites: 5, rank: 2 },
			{ print_id: 'b', favorites: 5, rank: 3 },
			{ print_id: 'd', favorites: 0, rank: 4 }
		]);
	});

	test('a refresh keeps every earlier row: out of the top N is in_top = 0, never dropped', () => {
		const ranked = rankFavorites([
			['a', 10],
			['b', 8],
			['c', 3]
		]);
		const first = planRefresh([], ranked, 2, 100);
		expect(first.map((r) => [r.print_id, r.rank, r.in_top, r.first_added_at])).toEqual([
			['a', 1, 1, 100],
			['b', 2, 1, 100]
		]);
		// b loses favourites, c gains; and a record disappears from the source.
		const again = rankFavorites([
			['b', 1],
			['c', 30],
			['e', 20]
		]);
		const second = planRefresh(first, again, 2, 200);
		const by = new Map(second.map((r) => [r.print_id, r]));
		expect(by.get('c')).toMatchObject({ rank: 1, in_top: 1, first_added_at: 200 });
		expect(by.get('e')).toMatchObject({ rank: 2, in_top: 1 });
		expect(by.get('b')).toMatchObject({ rank: 3, in_top: 0, favorites: 1, first_added_at: 100 });
		expect(by.get('a')).toMatchObject({ rank: null, in_top: 0, favorites: 10, first_added_at: 100 });
		expect(topIds(second, 2)).toEqual(['c', 'e']);
		expect(topIds(second, 1)).toEqual(['c']);
	});
});

describe('reading favourites from records', () => {
	test('reads numberOfFavorites (0 when absent) and caches by file stamp', async () => {
		const { dir, source } = recordsDir({ x: 3, y: undefined, z: 12 });
		const cache = join(mkdtempSync(join(tmpdir(), 'favs-cache-')), 'favs.json');
		const first = await readFavorites(await source.ids(), source.file, cache);
		expect(Object.fromEntries(first.counts)).toEqual({ x: 3, y: 0, z: 12 });
		expect(first.parsed).toBe(3);
		const second = await readFavorites(await source.ids(), source.file, cache);
		expect(second.parsed).toBe(0);
		expect(Object.fromEntries(second.counts)).toEqual({ x: 3, y: 0, z: 12 });
		writeFileSync(join(dir, 'x.json'), JSON.stringify({ blueprintString: '0x', numberOfFavorites: 40 }));
		const third = await readFavorites(await source.ids(), source.file, cache);
		expect(third.parsed).toBe(1);
		expect(third.counts.get('x')).toBe(40);
	});
});

describe('stored favourites stay in scope', () => {
	test('a non-flag run keeps a stored top-list pre-2.0 print, even after it left the top N', async () => {
		const { db } = migrated();
		const fdb = favoritesDb(db);
		const { dir, source } = recordsDir({ old: 50, modern: 40, other: 1 });
		const cache = join(mkdtempSync(join(tmpdir(), 'favs-cache-')), 'cache.json');
		await refreshFavorites(fdb, source, 2, cache, 1000);
		expect(topIds(await fdb.rows(), 2)).toEqual(['old', 'modern']);
		// `old` drops out of a smaller list.
		writeFileSync(join(dir, 'old.json'), JSON.stringify({ blueprintString: '0x', numberOfFavorites: 0 }));
		const meta = await refreshFavorites(fdb, source, 1, cache, 2000);
		expect(meta).toMatchObject({ n: 1, prints: 3, cutoff: 40 });
		const rows = await fdb.rows();
		expect(rows.find((r) => r.print_id === 'old')).toMatchObject({ in_top: 0, first_added_at: 1000 });
		// What the runner does without --top: every stored print is a favourite.
		const favorites = new Set(rows.map((r) => r.print_id));
		expect(takesPrint({ modern: false, favorite: favorites.has('old') })).toBe(true);
		expect(versionSkip([0, 17, 79, 0], favorites.has('old'))).toBeNull();
		// A print never in a list, with no 2.0+ page, is left out as before.
		expect(takesPrint({ modern: false, favorite: favorites.has('other') })).toBe(false);
		expect(versionSkip([1, 1, 110, 0], false)).toBe('pre-2.0');
		expect(versionSkip(null, false)).toBe('pre-2.0');
		expect(versionSkip([2, 0, 77, 0], false)).toBeNull();
		expect(await fdb.meta('favorites')).toMatchObject({ n: 1 });
	});

	test('--next --top looks again at favourites that were never queued as one', () => {
		expect(favoriteWork(undefined)).toBe(true);
		expect(favoriteWork([{ status: 'skipped', reason: 'pre-2.0' }])).toBe(true);
		// A book of planners only: its one row says there's nothing to draw, so it isn't taken again.
		expect(favoriteWork([{ status: 'skipped', reason: 'no blueprint pages (planners only)' }])).toBe(false);
		expect(
			favoriteWork([
				{ status: 'done', reason: null },
				{ status: 'skipped', reason: 'modded: x' }
			])
		).toBe(false);
		expect(withTopFirst(['c', 'a'], ['a', 'b', 'c', 'd'])).toEqual(['c', 'a', 'b', 'd']);
		expect(withTopFirst([], ['a', 'b'])).toEqual(['a', 'b']);
	});
});

describe('source check', () => {
	test('records whose stamp changed or that are gone', async () => {
		const { sqlite, db } = migrated();
		const { dir, source } = recordsDir({ a: 1, b: 2, c: 3 });
		const insert = sqlite.query('INSERT INTO render_prints (print_id, stamp, modern, checked_at) VALUES (?, ?, 1, 0)');
		for (const id of ['a', 'b']) insert.run(id, await source.stamp(id));
		insert.run('gone', '12:34');
		utimesSync(join(dir, 'b.json'), new Date(), new Date(Date.now() + 60_000));
		const meta = await checkSources(favoritesDb(db), source, 5000);
		expect(meta).toMatchObject({ compared: 3, changed: 1, gone: 1, unseen: 1 });
		expect(sqlite.query('SELECT print_id, stamp IS NULL AS gone FROM render_source_changes ORDER BY 1').all()).toEqual([
			{ print_id: 'b', gone: 0 },
			{ print_id: 'gone', gone: 1 }
		]);
	});
});
