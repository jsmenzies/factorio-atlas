/**
 * Author names for prints whose record has only the author's user id (most of them): the
 * `authors` table (migration 0017) and the name on each print's card row, search row and R2
 * document. `bun run authors --stage …` (scripts/authors.ts) runs it; the ingest keeps it up for new
 * prints from then on (`resolveAuthorName` in pipeline.ts).
 *
 * Names come from the prints' own records first, then Firebase's public
 * `users/<id>/displayName`, read once per author and never again: Firebase's bandwidth is billed to
 * factorioprints' maintainer, so the command asks slowly, one id at a time, and an answer of no
 * name is kept too. A print whose record names its author keeps that name.
 */
import { rowsWritten as written } from '../d1-batch.js';
import { bumpPageVersion } from '../page-cache.js';
import { analysisKey, withAuthorName } from './print-doc.js';

export const FIREBASE_URL = 'https://facorio-blueprints.firebaseio.com';

export interface AuthorPrint {
	id: string;
	author_id: string;
	author_name: string | null;
}

export interface AuthorState {
	/** Every print with an author id. */
	prints: AuthorPrint[];
	/** Every `authors` row: id → name, null when Firebase has none. */
	authors: Map<string, string | null>;
	/** print id → FTS rowid (print_id is UNINDEXED, so updates go by rowid). */
	searchRows: Map<string, number>;
}

/** A name as shown on the site: trimmed, blank means none. */
export const cleanName = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);

/** Authors with no row yet whose prints' records name them: [id, name]. Pure. */
export const recordNames = (s: Pick<AuthorState, 'prints' | 'authors'>): [string, string][] => {
	const out = new Map<string, string>();
	for (const p of s.prints) if (p.author_name && !s.authors.has(p.author_id) && !out.has(p.author_id)) out.set(p.author_id, p.author_name);
	return [...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
};

/** Authors with no row at all (and no name from a record), sorted by how many prints they have, most first. Pure. */
export const unknownAuthors = (s: Pick<AuthorState, 'prints' | 'authors'>): string[] => {
	const named = new Set(recordNames(s).map(([id]) => id));
	const prints = new Map<string, number>();
	for (const p of s.prints)
		if (!s.authors.has(p.author_id) && !named.has(p.author_id)) prints.set(p.author_id, (prints.get(p.author_id) ?? 0) + 1);
	return [...prints].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).map(([id]) => id);
};

export interface NameFix {
	id: string;
	name: string;
	/** Its FTS row, when the print has one. */
	rowid: number | null;
}

/** Prints with no name whose author now has one. Pure. */
export const planNameFixes = (s: AuthorState): NameFix[] =>
	s.prints.flatMap((p) => {
		const name = p.author_name ? null : (s.authors.get(p.author_id) ?? null);
		return name ? [{ id: p.id, name, rowid: s.searchRows.get(p.id) ?? null }] : [];
	});

/** Everything the plan needs, in pages by key (no read sorts a table). */
export async function loadAuthorState(db: D1Database, pageSize = 5000): Promise<AuthorState> {
	const prints: AuthorPrint[] = [];
	for (let after = ''; ;) {
		const { results } = await db
			.prepare('SELECT id, author_id, author_name FROM prints WHERE id > ? ORDER BY id LIMIT ?')
			.bind(after, pageSize)
			.all<{ id: string; author_id: string | null; author_name: string | null }>();
		for (const r of results) if (r.author_id) prints.push({ id: r.id, author_id: r.author_id, author_name: r.author_name });
		if (results.length < pageSize) break;
		after = results[results.length - 1].id;
	}
	const authors = new Map<string, string | null>();
	for (let after = ''; ;) {
		const { results } = await db
			.prepare('SELECT author_id, display_name FROM authors WHERE author_id > ? ORDER BY author_id LIMIT ?')
			.bind(after, pageSize)
			.all<{ author_id: string; display_name: string | null }>();
		for (const r of results) authors.set(r.author_id, r.display_name);
		if (results.length < pageSize) break;
		after = results[results.length - 1].author_id;
	}
	const searchRows = new Map<string, number>();
	for (let after = 0; ;) {
		const { results } = await db
			.prepare('SELECT rowid, print_id FROM print_search WHERE rowid > ? ORDER BY rowid LIMIT ?')
			.bind(after, pageSize)
			.all<{ rowid: number; print_id: string }>();
		for (const r of results) searchRows.set(r.print_id, r.rowid);
		if (results.length < pageSize) break;
		after = results[results.length - 1].rowid;
	}
	return { prints, authors, searchRows };
}

/** `authors` rows, as many per statement as stay under D1's 100 bound parameters. */
export function authorRowStatements(db: D1Database, rows: [string, string | null][], source: 'record' | 'firebase', now = Date.now()) {
	const out: D1PreparedStatement[] = [];
	for (let i = 0; i < rows.length; i += 33) {
		const c = rows.slice(i, i + 33);
		out.push(
			db
				.prepare(
					`INSERT INTO authors (author_id, display_name, source, fetched_at) VALUES ${c.map(() => `(?, ?, '${source}', ?)`).join(', ')}
					ON CONFLICT (author_id) DO NOTHING`
				)
				.bind(...c.flatMap(([id, name]) => [id, name, now]))
		);
	}
	return out;
}

/** One author's name from Firebase: the name, or null when the user has none. Throws on anything but a 200. */
export async function fetchDisplayName(authorId: string, base = FIREBASE_URL, fetcher: typeof fetch = fetch): Promise<string | null> {
	const res = await fetcher(`${base}/users/${encodeURIComponent(authorId)}/displayName.json`, {
		headers: { accept: 'application/json' }
	});
	if (!res.ok) throw new Error(`Firebase answered ${res.status} for user ${authorId}`);
	return cleanName(await res.json());
}

/**
 * Put the names on prints: each R2 document first (read, and written only when its name differs),
 * then the card row and the search row, so a stopped run is picked up by the next one (it plans from
 * D1, where the name lands last). The card row update only fills a missing name.
 */
export async function applyNameFixes(
	db: D1Database,
	bucket: R2Bucket,
	fixes: NameFix[],
	options: { chunk?: number; concurrency?: number; onChunk?: (done: number, docsWritten: number) => void } = {}
) {
	const chunk = options.chunk ?? 50;
	const concurrency = options.concurrency ?? 8;
	let docsWritten = 0;
	let rowsWritten = 0;
	for (let i = 0; i < fixes.length; i += chunk) {
		const part = fixes.slice(i, i + chunk);
		for (let j = 0; j < part.length; j += concurrency) {
			await Promise.all(
				part.slice(j, j + concurrency).map(async (f) => {
					const text = await (await bucket.get(analysisKey(f.id)))?.text();
					if (text === undefined) return;
					const next = withAuthorName(text, f.name);
					if (next === text) return;
					await bucket.put(analysisKey(f.id), next, { httpMetadata: { contentType: 'application/json' } });
					docsWritten++;
				})
			);
		}
		const results = await db.batch(
			part.flatMap((f) => [
				db.prepare('UPDATE prints SET author_name = ? WHERE id = ? AND author_name IS NULL').bind(f.name, f.id),
				...(f.rowid === null ? [] : [db.prepare('UPDATE print_search SET author = ? WHERE rowid = ?').bind(f.name, f.rowid)])
			])
		);
		rowsWritten += written(results);
		options.onChunk?.(Math.min(i + chunk, fixes.length), docsWritten);
	}
	// Cached pages still show the old names (lib/server/page-cache.ts).
	if (docsWritten + rowsWritten > 0) await bumpPageVersion(db).run();
	return { docsWritten, rowsWritten };
}
