/**
 * The top-N most-favourited prints (`render_favorites`, migration 0014), rendered as well as every
 * print with a 2.0+ page, and the check of the source for records that changed since a run looked
 * at them (`render_source_changes`). Favourites come from each record's `numberOfFavorites` in the
 * local mirror clone (or the raw-records folder), never from Firebase.
 *
 * A print that was ever in a list keeps its row: a refresh that leaves it out of the top N sets
 * `in_top = 0`. The runner treats every print with a row as in scope (its pre-2.0 pages rendered,
 * its rows never dropped for having no 2.0+ page), whatever the run's flags.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileStamp } from './source.js';
import { inBatches, retrying } from './queue.js';

export interface FavoriteRow {
	print_id: string;
	favorites: number;
	rank: number | null;
	in_top: number;
	refreshed_at: number;
	first_added_at: number;
}

/** The latest refresh, in render_meta under 'favorites'. */
export interface FavoritesMeta {
	n: number;
	source: string;
	/** Records read (every print in the source), and how many were parsed (the rest came from the cache). */
	prints: number;
	parsed: number;
	/** The smallest favourites count in the top N. */
	cutoff: number;
	refreshed_at: number;
	ms: number;
}

/** The latest source check, in render_meta under 'source-check'. */
export interface SourceCheckMeta {
	source: string;
	/** Prints compared (render_prints rows), changed since a run looked at them, gone from the source. */
	compared: number;
	changed: number;
	gone: number;
	/** Prints in the source that no run has looked at yet. */
	unseen: number;
	checked_at: number;
	ms: number;
}

/** Highest favourites first; ties by id, so ranks are stable. */
export function rankFavorites(counts: Iterable<[string, number]>): { print_id: string; favorites: number; rank: number }[] {
	return [...counts]
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.map(([print_id, favorites], i) => ({ print_id, favorites, rank: i + 1 }));
}

/**
 * The rows a refresh to the top `n` writes: the top n with in_top = 1 (first_added_at kept), and
 * every earlier row outside it with in_top = 0 and its current rank (NULL when the record is gone).
 * No row is ever dropped.
 */
export function planRefresh(
	existing: Pick<FavoriteRow, 'print_id' | 'favorites' | 'first_added_at'>[],
	ranked: { print_id: string; favorites: number; rank: number }[],
	n: number,
	now: number
): FavoriteRow[] {
	const old = new Map(existing.map((r) => [r.print_id, r]));
	const byId = new Map(ranked.map((r) => [r.print_id, r]));
	const out: FavoriteRow[] = [];
	for (const r of ranked.slice(0, n)) {
		out.push({ ...r, in_top: 1, refreshed_at: now, first_added_at: old.get(r.print_id)?.first_added_at ?? now });
		old.delete(r.print_id);
	}
	for (const r of old.values()) {
		const cur = byId.get(r.print_id);
		out.push({
			print_id: r.print_id,
			favorites: cur?.favorites ?? r.favorites,
			rank: cur?.rank ?? null,
			in_top: 0,
			refreshed_at: now,
			first_added_at: r.first_added_at
		});
	}
	return out;
}

/** The top `n` of the stored list, by rank: the prints `--top n` adds to a run. */
export const topIds = (rows: Pick<FavoriteRow, 'print_id' | 'rank' | 'in_top'>[], n: number): string[] =>
	rows
		.filter((r) => r.in_top === 1 && r.rank !== null && r.rank <= n)
		.sort((a, b) => a.rank! - b.rank!)
		.map((r) => r.print_id);

/** `numberOfFavorites` of a record's JSON text; 0 when it has none. */
export const favoritesOf = (text: string): number => {
	const v = (JSON.parse(text) as { numberOfFavorites?: unknown }).numberOfFavorites;
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
};

/** Cache of favourites by record file: id → [stamp, favourites], so a refresh parses only changed files. */
type Cache = Record<string, [string, number]>;

/** Where readFavorites keeps its cache for the source folder `dir`. */
export const favoritesCacheFile = (cacheDir: string, dir: string) =>
	join(cacheDir, `favorites-${createHash('sha256').update(dir).digest('hex').slice(0, 12)}.json`);

/**
 * Every print's favourites from its record file (`file(id)`). Files whose stamp matches the
 * cache aren't read; parsing all 18k mirror files takes about 1.5 s, stat'ing them 40 ms.
 */
export async function readFavorites(
	ids: string[],
	file: (id: string) => string,
	cacheFile: string
): Promise<{ counts: Map<string, number>; parsed: number }> {
	let cache: Cache = {};
	try {
		cache = JSON.parse(await readFile(cacheFile, 'utf8')) as Cache;
	} catch {
		// No cache yet (or a broken one): read everything.
	}
	const counts = new Map<string, number>();
	const next: Cache = {};
	let parsed = 0;
	for (let i = 0; i < ids.length; i += 64) {
		const chunk = ids.slice(i, i + 64);
		const got = await Promise.all(
			chunk.map(async (id) => {
				const path = file(id);
				const stamp = await fileStamp(path);
				if (stamp === null) return null;
				const hit = cache[id];
				if (hit && hit[0] === stamp) return [stamp, hit[1]] as [string, number];
				try {
					const favs = favoritesOf(await readFile(path, 'utf8'));
					parsed++;
					return [stamp, favs] as [string, number];
				} catch {
					return null;
				}
			})
		);
		chunk.forEach((id, j) => {
			const g = got[j];
			if (!g) return;
			counts.set(id, g[1]);
			next[id] = g;
		});
	}
	await mkdir(dirname(cacheFile), { recursive: true });
	await writeFile(`${cacheFile}.tmp`, JSON.stringify(next));
	await rename(`${cacheFile}.tmp`, cacheFile);
	return { counts, parsed };
}

/** Prints whose source stamp differs from the one render_prints holds, or whose file is gone. */
export async function changedSources(
	seen: Map<string, string | null>,
	stamp: (id: string) => Promise<string | null>
): Promise<{ changed: { print_id: string; stamp: string | null }[]; gone: number }> {
	const ids = [...seen.keys()];
	const changed: { print_id: string; stamp: string | null }[] = [];
	let gone = 0;
	for (let i = 0; i < ids.length; i += 64) {
		const chunk = ids.slice(i, i + 64);
		const got = await Promise.all(chunk.map((id) => stamp(id)));
		chunk.forEach((id, j) => {
			if (got[j] === seen.get(id)) return;
			if (got[j] === null) gone++;
			changed.push({ print_id: id, stamp: got[j] });
		});
	}
	return { changed, gone };
}

const metaStatement = (db: D1Database, key: string, value: unknown, at: number) =>
	db
		.prepare(
			'INSERT INTO render_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
		)
		.bind(key, JSON.stringify(value), at);

export function favoritesDb(db: D1Database) {
	return {
		rows: () => retrying('favourites', async () => (await db.prepare('SELECT * FROM render_favorites').all<FavoriteRow>()).results),

		meta: <T>(key: string) =>
			retrying('render meta', async () => {
				const r = await db.prepare('SELECT value FROM render_meta WHERE key = ?').bind(key).first<{ value: string }>();
				return r ? (JSON.parse(r.value) as T) : null;
			}),

		/** Write a refresh's rows and its meta (the meta last: a refresh cut short is redone). */
		writeRefresh: async (rows: FavoriteRow[], meta: FavoritesMeta) => {
			const sql = `INSERT INTO render_favorites (print_id, favorites, rank, in_top, refreshed_at, first_added_at) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT (print_id) DO UPDATE SET favorites = excluded.favorites, rank = excluded.rank, in_top = excluded.in_top,
				refreshed_at = excluded.refreshed_at`;
			await inBatches(
				db,
				'write favourites',
				rows.map((r) => db.prepare(sql).bind(r.print_id, r.favorites, r.rank, r.in_top, r.refreshed_at, r.first_added_at))
			);
			await retrying('write favourites meta', () => metaStatement(db, 'favorites', meta, meta.refreshed_at).run());
		},

		/** render_prints' stamps, for the source check. */
		seenStamps: () =>
			retrying(
				'seen stamps',
				async () =>
					new Map(
						(await db.prepare('SELECT print_id, stamp FROM render_prints').all<{ print_id: string; stamp: string | null }>()).results.map(
							(r) => [r.print_id, r.stamp]
						)
					)
			),

		/** Replace the check's rows and meta. */
		writeSourceCheck: async (changed: { print_id: string; stamp: string | null }[], meta: SourceCheckMeta) => {
			const sql = 'INSERT INTO render_source_changes (print_id, stamp, checked_at) VALUES (?, ?, ?)';
			await retrying('clear source changes', () => db.prepare('DELETE FROM render_source_changes').run());
			await inBatches(
				db,
				'write source changes',
				changed.map((c) => db.prepare(sql).bind(c.print_id, c.stamp, meta.checked_at))
			);
			await retrying('write source-check meta', () => metaStatement(db, 'source-check', meta, meta.checked_at).run());
		}
	};
}

export type FavoritesDb = ReturnType<typeof favoritesDb>;

/** Rank every print in the source and store the top `n` (see planRefresh). */
export async function refreshFavorites(
	fdb: FavoritesDb,
	source: { label: string; ids(): Promise<string[]>; file(id: string): string },
	n: number,
	cacheFile: string,
	now = Date.now()
): Promise<FavoritesMeta> {
	const t0 = Date.now();
	const ids = await source.ids();
	const { counts, parsed } = await readFavorites(ids, (id) => source.file(id), cacheFile);
	const ranked = rankFavorites(counts);
	const rows = planRefresh(await fdb.rows(), ranked, n, now);
	const top = ranked.slice(0, n);
	const meta: FavoritesMeta = {
		n,
		source: source.label,
		prints: ids.length,
		parsed,
		cutoff: top.at(-1)?.favorites ?? 0,
		refreshed_at: now,
		ms: Date.now() - t0
	};
	await fdb.writeRefresh(rows, meta);
	return meta;
}

/** Compare every print a run has looked at with its record file now, and store what changed. */
export async function checkSources(
	fdb: FavoritesDb,
	source: { label: string; ids(): Promise<string[]>; stamp(id: string): Promise<string | null> },
	now = Date.now()
): Promise<SourceCheckMeta> {
	const t0 = Date.now();
	const seen = await fdb.seenStamps();
	const { changed, gone } = await changedSources(seen, (id) => source.stamp(id));
	const unseen = (await source.ids()).filter((id) => !seen.has(id)).length;
	const meta: SourceCheckMeta = {
		source: source.label,
		compared: seen.size,
		changed: changed.length - gone,
		gone,
		unseen,
		checked_at: now,
		ms: Date.now() - t0
	};
	await fdb.writeSourceCheck(changed, meta);
	return meta;
}
