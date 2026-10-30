/**
 * The soft fold. Prints whose whole content is exactly the same (the whole-print hash, from JOIN_MIN_SIZE
 * entities + tiles up, current versions, live prints) form a group; the earliest by its live sources'
 * upload time (factorioprints: `createdDate`), then by id, is the group's original.
 *
 * Every later copy is folded, whoever posted it (user, 2026-10-30; until then only the same author's
 * double posts were, and anyone else's copy stayed listed with `identical_to`): `prints.duplicate_of`
 * names the group's original. A copy stays out of search, landing pages and the sitemap (the `folded_yes`
 * facet token, queries.ts `matchExpression`, and the column for unfiltered searches and facet_counts); its
 * page's canonical link points at the original and says "Same blueprint as …, posted earlier by …".
 * Prints under JOIN_MIN_SIZE form no group: small standard designs are often built alike.
 *
 * `prints.identical_to` (and the document's `identical_to`) is no longer set by the rule: a refold clears
 * it; the page still reads it, for documents written before.
 *
 * Both are mirrored into the print's R2 document (`copy_of`, `identical_to`, ids only: the page reads
 * the other print's title and author from that print's document), written before the D1 rows, so a page
 * cached under a new page-cache version always agrees.
 *
 * `planFold` reads the groups one print touches (its own, and those of prints pointing at it: it may
 * have changed or gone); `planAllFolds` reads them all (`bun run fold`). `foldStatements` writes the
 * differences. Narrowing or widening the rule is `foldGroup` alone, plus a FOLD_VERSION bump.
 */
import { bumpPageVersion } from '../page-cache.js';
import { addToken, hasToken, removeToken } from './facet-token.js';
import { JOIN_MIN_SIZE } from './identity-db.js';

/**
 * The rule's version: bump it when `foldGroup` changes, so the next backfill (and so the next update's
 * ingest step, whose skip key carries it) refolds every group. 2: every later copy folded, whoever posted it.
 */
export const FOLD_VERSION = 2;

/** The facet token of a folded print (first in its `facets` column, as `render_yes`). */
export const FOLDED_TOKEN = 'folded_yes';

/** A print's place in its group: both null for the original and for every print in no group. */
export interface FoldState {
	readonly duplicateOf: string | null;
	readonly identicalTo: string | null;
}

export interface FoldMember extends FoldState {
	readonly printId: string;
	/** The D1 columns differ from this: the rows and the document need writing. */
	readonly changed: boolean;
}

export interface MemberRow {
	readonly id: string;
	/** The earliest upload time of its live sources, or null when none says. */
	readonly posted: number | null;
}

const NONE: FoldState = { duplicateOf: null, identicalTo: null };

const order = (a: MemberRow, b: MemberRow) =>
	(a.posted ?? Number.MAX_SAFE_INTEGER) - (b.posted ?? Number.MAX_SAFE_INTEGER) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The rule: where each member of one group should point (the earliest is the original; no posting time sorts last, ties by id). Pure. */
export const foldGroup = (rows: readonly MemberRow[]): Map<string, FoldState> => {
	const [first, ...later] = [...rows].sort(order);
	const out = new Map<string, FoldState>();
	if (first) out.set(first.id, NONE);
	for (const m of later) out.set(m.id, { duplicateOf: first.id, identicalTo: null });
	return out;
};

interface Row extends MemberRow {
	readonly sha256: string;
	readonly duplicate_of: string | null;
	readonly identical_to: string | null;
}

/** Members of the groups whose whole-print hash `shaFilter` picks. */
const members = (shaFilter: string) => `
	SELECT f.sha256 AS sha256, f.print_id AS id, p.duplicate_of AS duplicate_of, p.identical_to AS identical_to,
		(SELECT MIN(COALESCE(s.uploaded_at, s.first_seen)) FROM print_sources s WHERE s.print_id = f.print_id AND s.gone_at IS NULL) AS posted
	FROM print_fingerprints f JOIN prints p ON p.id = f.print_id
	WHERE f.kind = 'print' AND f.current = 1 AND f.size >= ${JOIN_MIN_SIZE} AND f.sha256 IN (${shaFilter})`;

type Pointing = { id: string; duplicate_of: string | null; identical_to: string | null };

const plan = (groups: readonly Row[], pointing: readonly Pointing[]): FoldMember[] => {
	const bySha = new Map<string, Row[]>();
	for (const r of groups) bySha.set(r.sha256, [...(bySha.get(r.sha256) ?? []), r]);
	const rows = new Map<string, Pointing>();
	const want = new Map<string, FoldState>();
	for (const g of bySha.values()) {
		for (const [id, state] of foldGroup(g)) want.set(id, state);
		for (const r of g) rows.set(r.id, r);
	}
	for (const r of pointing) if (!rows.has(r.id)) rows.set(r.id, r);
	return [...rows.values()].map((r) => {
		const w = want.get(r.id) ?? NONE;
		return { printId: r.id, ...w, changed: r.duplicate_of !== w.duplicateOf || r.identical_to !== w.identicalTo };
	});
};

/** The groups `printId` touches, as they should be. Reads only: one batch, then one statement. */
export async function planFold(db: D1Database, printId: string): Promise<FoldMember[]> {
	const [hashes, pointing] = await db.batch<Record<string, unknown>>([
		db
			.prepare(
				`SELECT DISTINCT sha256 FROM print_fingerprints
				WHERE kind = 'print' AND current = 1 AND size >= ?2
					AND print_id IN (SELECT ?1 UNION SELECT id FROM prints WHERE duplicate_of = ?1 UNION SELECT id FROM prints WHERE identical_to = ?1)`
			)
			.bind(printId, JOIN_MIN_SIZE),
		// Prints pointing at it, and itself, should they be in no group any more (changed, failed or gone).
		db
			.prepare(
				`SELECT id, duplicate_of, identical_to FROM prints
				WHERE duplicate_of = ?1 OR identical_to = ?1 OR (id = ?1 AND (duplicate_of IS NOT NULL OR identical_to IS NOT NULL))`
			)
			.bind(printId)
	]);
	const shas = hashes.results.map((h) => h.sha256 as string);
	const groups = shas.length
		? (await db.prepare(members('SELECT value FROM json_each(?)')).bind(JSON.stringify(shas)).all<Row>()).results
		: [];
	return plan(groups, pointing.results as unknown as Pointing[]);
}

/** Every group in the stage (whole-print hashes two live prints share), and every print that points anywhere now. */
export async function planAllFolds(db: D1Database): Promise<FoldMember[]> {
	const shared = `SELECT g.sha256 FROM print_fingerprints g JOIN prints q ON q.id = g.print_id
		WHERE g.kind = 'print' AND g.current = 1 AND g.size >= ${JOIN_MIN_SIZE} GROUP BY g.sha256 HAVING COUNT(*) > 1`;
	const [groups, pointing] = await db.batch<Record<string, unknown>>([
		db.prepare(members(shared)),
		db.prepare('SELECT id, duplicate_of, identical_to FROM prints WHERE duplicate_of IS NOT NULL OR identical_to IS NOT NULL')
	]);
	return plan(groups.results as unknown as Row[], pointing.results as unknown as Pointing[]);
}

const HAS_FOLDED = hasToken(FOLDED_TOKEN);

/**
 * The D1 writes for the members whose fold changed; none when nothing changed. With `bump`, a page-cache
 * bump too (a backfill leaves it to its own rebuildFacets). The FTS rows are found by print id, which is
 * UNINDEXED (there is no index to find a rowid by either), so all the token changes are two statements,
 * one pass over print_search each, however many prints changed: a first refold of ~100 copies is two scans, not ~100.
 */
export const foldStatements = (
	db: D1Database,
	changes: readonly FoldMember[],
	{ bump = true, now = Date.now() }: { bump?: boolean; now?: number } = {}
): D1PreparedStatement[] => {
	const changed = changes.filter((m) => m.changed);
	if (!changed.length) return [];
	const folded = changed.filter((m) => m.duplicateOf).map((m) => m.printId);
	const unfolded = changed.filter((m) => !m.duplicateOf).map((m) => m.printId);
	const ids = 'print_id IN (SELECT value FROM json_each(?))';
	return [
		db
			.prepare(
				`UPDATE prints SET duplicate_of = value ->> 1, identical_to = value ->> 2
				FROM json_each(?) WHERE prints.id = value ->> 0`
			)
			.bind(JSON.stringify(changed.map((m) => [m.printId, m.duplicateOf, m.identicalTo]))),
		...(folded.length
			? [db.prepare(`UPDATE print_search SET ${addToken(FOLDED_TOKEN)} WHERE ${ids} AND NOT ${HAS_FOLDED}`).bind(JSON.stringify(folded))]
			: []),
		...(unfolded.length
			? [db.prepare(`UPDATE print_search SET ${removeToken(FOLDED_TOKEN)} WHERE ${ids} AND ${HAS_FOLDED}`).bind(JSON.stringify(unfolded))]
			: []),
		...(bump ? [bumpPageVersion(db, now)] : [])
	];
};

/** A print's fold as the D1 rows hold it now (`duplicate_of`, `identical_to`), for its document's first write: the repository's `docState` batch. */
export const foldStatement = (db: D1Database, printId: string) =>
	db.prepare('SELECT duplicate_of, identical_to FROM prints WHERE id = ?').bind(printId);

/** The upsert's guard: the token for a folded print (its `duplicate_of` survives re-ingests). */
export const FOLDED_PREFIX_SQL = `CASE WHEN EXISTS (SELECT 1 FROM prints WHERE id = ? AND duplicate_of IS NOT NULL) THEN '${FOLDED_TOKEN} ' ELSE '' END`;

/**
 * `meta.fold_dirty`: set while a backfill has written prints whose folds it hasn't recomputed yet (from the
 * first print it hands over until its refold at the end succeeds). A run that is quit, or whose refold
 * fails, leaves it set; the next backfill and `bun run fold` refold, then clear it. `meta.fold_version`
 * is the FOLD_VERSION the last full refold applied: any other value (or none) counts as dirty too.
 */
export const FOLD_DIRTY = 'fold_dirty';
const FOLD_VERSION_KEY = 'fold_version';

export const markFoldDirty = (db: D1Database, now = Date.now()) =>
	db
		.prepare(`INSERT INTO meta (key, value) VALUES ('${FOLD_DIRTY}', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
		.bind(String(now))
		.run();

/** After a full refold under this FOLD_VERSION: nothing left to recompute. */
export const clearFoldDirty = (db: D1Database) =>
	db.batch([
		db.prepare(`DELETE FROM meta WHERE key = '${FOLD_DIRTY}'`),
		db
			.prepare(`INSERT INTO meta (key, value) VALUES ('${FOLD_VERSION_KEY}', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
			.bind(String(FOLD_VERSION))
	]);

/** Whether every group must be refolded: a backfill left it to do, or the rule changed since the last full refold. */
export const isFoldDirty = async (db: D1Database) => {
	const row = await db
		.prepare(
			`SELECT EXISTS (SELECT 1 FROM meta WHERE key = '${FOLD_DIRTY}') AS dirty, (SELECT value FROM meta WHERE key = '${FOLD_VERSION_KEY}') AS version`
		)
		.first<{ dirty: number; version: string | null }>();
	return row?.dirty === 1 || row?.version !== String(FOLD_VERSION);
};
