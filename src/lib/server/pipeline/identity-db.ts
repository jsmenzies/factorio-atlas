/**
 * The identity tables (migration 0022): `print_sources` and `print_fingerprints`, and the
 * `removal_blocks` checks every way in shares (migration 0021, from the removal requests). Plain D1,
 * Worker-safe. Statements are returned, not run, so they go into the same batch as a print's own rows.
 */
import type { Site } from '#lib/print-id.js';
import { docSources, type PrintSource } from '#lib/sources.js';
import { sourceBlock } from '../removal-blocks.js';
import type { PrintFingerprint } from './identity.js';
import type { SourceMeta } from './source-record.js';

/** A match joins two prints only from this many entities + tiles (the whole print) up. */
export const JOIN_MIN_SIZE = 50;
/** Pages with fewer entities + tiles are left out of page-overlap suggestions (standard little pieces). */
export const PAGE_MIN_SIZE = 20;

export type FingerprintKind = 'print' | 'print_layout' | 'page' | 'page_layout';

export interface PrintSourceRow {
	readonly print_id: string;
	readonly site: Site;
	readonly site_id: string;
	readonly url: string;
	readonly uploaded_at: number | null;
	readonly first_seen: number;
	readonly updated_at: number | null;
	readonly gone_at: number | null;
}

/** [kind, sha256, page_path, size] for every hash of a print. */
export const fingerprintRows = (fp: PrintFingerprint): [FingerprintKind, string, string, number][] => [
	...(fp.whole
		? ([
				['print', fp.whole.exact, '', fp.whole.size],
				['print_layout', fp.whole.layout, '', fp.whole.size]
			] as [FingerprintKind, string, string, number][])
		: []),
	...fp.pages.flatMap((p): [FingerprintKind, string, string, number][] => [
		['page', p.exact, p.path, p.entities + p.tiles],
		['page_layout', p.layout, p.path, p.entities + p.tiles]
	])
];

/**
 * A print's source row and fingerprints, for the batch that writes its rows: the source is (re)attached
 * to the print and live again; earlier fingerprints stay, marked not current. All fingerprints go in one
 * statement (rows as JSON), whatever the book's size.
 */
export const identityStatements = (
	db: D1Database,
	printId: string,
	source: SourceMeta,
	fp: PrintFingerprint,
	now = Date.now()
): D1PreparedStatement[] => [
	db
		.prepare(
			`INSERT INTO print_sources (site, site_id, print_id, url, uploaded_at, updated_at, first_seen, gone_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
			ON CONFLICT (site, site_id) DO UPDATE SET print_id = excluded.print_id, url = excluded.url,
				uploaded_at = excluded.uploaded_at, updated_at = excluded.updated_at, gone_at = NULL`
		)
		.bind(source.site, source.siteId, printId, source.url, source.uploadedAt, source.updatedAt, now),
	db.prepare('UPDATE print_fingerprints SET current = 0 WHERE print_id = ? AND current = 1').bind(printId),
	db
		.prepare(
			`INSERT INTO print_fingerprints (kind, sha256, print_id, page_path, size, first_seen, current)
			SELECT value ->> 0, value ->> 1, ?1, value ->> 2, value ->> 3, ?2, 1 FROM json_each(?3) WHERE true
			ON CONFLICT (kind, sha256, print_id, page_path) DO UPDATE SET current = 1, size = excluded.size`
		)
		.bind(printId, now, JSON.stringify(fingerprintRows(fp)))
];

/**
 * For purgePrintData's batch (removals; wired in when the branches meet): the print's fingerprints go,
 * its sources stay, every one marked gone. So `sourceGone` run again after a purge still finds the
 * print (to refold), and a source that comes back reattaches (identityStatements clears `gone_at`).
 */
export const identityPurgeStatements = (db: D1Database, printId: string, now = Date.now()): D1PreparedStatement[] => [
	db.prepare('DELETE FROM print_fingerprints WHERE print_id = ?').bind(printId),
	db.prepare('UPDATE print_sources SET gone_at = ? WHERE print_id = ? AND gone_at IS NULL').bind(now, printId)
];

/**
 * The hashes a takedown blocks (`removal_blocks` 'sha256'): every exact hash the print ever had, whole
 * and per page, from JOIN_MIN_SIZE up. Smaller pages are left out: a block on a lone pole or a 3×3
 * solar block would refuse every print that has one.
 */
export const fingerprintBlockValues = async (db: D1Database, printId: string): Promise<string[]> =>
	(
		await db
			.prepare(
				`SELECT DISTINCT sha256 FROM print_fingerprints WHERE print_id = ? AND kind IN ('print', 'page') AND size >= ? ORDER BY sha256`
			)
			.bind(printId, JOIN_MIN_SIZE)
			.all<{ sha256: string }>()
	).results.map((r) => r.sha256);

/** `sourcesOf`'s statement, for a batch. */
export const sourcesStatement = (db: D1Database, printId: string) =>
	db
		.prepare(
			`SELECT print_id, site, site_id, url, uploaded_at, first_seen, updated_at, gone_at FROM print_sources
			WHERE print_id = ? ORDER BY gone_at IS NOT NULL, COALESCE(uploaded_at, first_seen), site, site_id`
		)
		.bind(printId);

/** Every source of a print, live and gone, earliest upload first. */
export const sourcesOf = async (db: D1Database, printId: string): Promise<PrintSourceRow[]> =>
	(await sourcesStatement(db, printId).all<PrintSourceRow>()).results;

/** The live sources, the credited one (posted first) first. */
export const liveSources = (sources: readonly PrintSourceRow[]): PrintSourceRow[] =>
	sources
		.filter((s) => s.gone_at === null)
		.sort(
			(a, b) =>
				(a.uploaded_at ?? a.first_seen) - (b.uploaded_at ?? b.first_seen) ||
				a.site.localeCompare(b.site) ||
				a.site_id.localeCompare(b.site_id)
		);

/** What a print's R2 document lists of these sources (`docSources`: its live ones, credited first; undefined for its own alone). */
export const docSourcesOf = (printId: string, sources: readonly PrintSourceRow[]): PrintSource[] | undefined =>
	docSources(printId, liveSources(sources));

/** The credited source: the live one posted first. */
export const winnerOf = (sources: readonly PrintSourceRow[]): PrintSourceRow | null => liveSources(sources)[0] ?? null;

/**
 * A site's sources whose print was purged as 'gone' (a tombstone, no `prints` row): every source of a purged
 * print is marked gone, including one its site still has when a hand-over couldn't ingest it (uploads/gate.ts
 * `sourceGone`). The site's next admission sends those still on the site through the gate again
 * (scripts/polled.ts), where each comes out a print of its own, or joins what it copies.
 */
export const lostSources = async (db: D1Database, site: Site): Promise<string[]> =>
	(
		await db
			.prepare(
				`SELECT s.site_id AS site_id FROM print_sources s JOIN print_tombstones t ON t.print_id = s.print_id AND t.kind = 'gone'
				WHERE s.site = ? AND NOT EXISTS (SELECT 1 FROM prints p WHERE p.id = s.print_id) ORDER BY s.site_id`
			)
			.bind(site)
			.all<{ site_id: string }>()
	).results.map((r) => r.site_id);

/** A site's ids that are a source of a live print (add-record.ts `knownSource` for every id at once). */
export const liveSourceIds = async (db: D1Database, site: Site): Promise<Set<string>> =>
	new Set(
		(
			await db
				.prepare(`SELECT s.site_id AS site_id FROM print_sources s JOIN prints p ON p.id = s.print_id WHERE s.site = ?`)
				.bind(site)
				.all<{ site_id: string }>()
		).results.map((r) => r.site_id)
	);

/**
 * `sources` as they will be once `source` is written for `printId` (`identityStatements`: attached and
 * live again), for a document written before that batch.
 */
export const withSourceRow = (
	printId: string,
	sources: readonly PrintSourceRow[],
	source: SourceMeta,
	now = Date.now()
): PrintSourceRow[] => {
	const same = (s: PrintSourceRow) => s.site === source.site && s.site_id === source.siteId;
	const old = sources.find(same);
	return [
		...sources.filter((s) => !same(s)),
		{
			print_id: printId,
			site: source.site,
			site_id: source.siteId,
			url: source.url,
			uploaded_at: source.uploadedAt,
			updated_at: source.updatedAt,
			first_seen: old?.first_seen ?? now,
			gone_at: null
		}
	];
};

/** What an approved removal blocks a record by, and the removed print the block came from. */
export interface BlockHit {
	readonly by: 'source' | 'sha256';
	readonly printId: string;
}

/**
 * Whether an approved removal (`removal_blocks`, migration 0021) blocks a record: its source
 * (removal-blocks.ts `sourceBlock`) or any of `hashes` (`blockHashes`). One query.
 */
export const blockedBy = async (
	db: D1Database,
	source: { readonly site: Site; readonly siteId: string } | null,
	hashes: readonly string[]
): Promise<BlockHit | null> => {
	const row = await db
		.prepare(
			`SELECT kind, print_id FROM removal_blocks
			WHERE (kind = 'source' AND value = ?1) OR (kind = 'sha256' AND value IN (SELECT value FROM json_each(?2)))
			ORDER BY kind = 'sha256' LIMIT 1`
		)
		.bind(source ? sourceBlock(source.site, source.siteId).value : '', JSON.stringify([...new Set(hashes)]))
		.first<{ kind: 'source' | 'sha256'; print_id: string }>();
	return row ? { by: row.kind, printId: row.print_id } : null;
};

/** A live print with exactly the same whole content as another (fold.ts groups), for the removal approval. */
export interface IdenticalCopy {
	readonly id: string;
	readonly title: string;
	readonly author_name: string | null;
	/** By the same author (same site, same author id): marked in the removal queue. */
	readonly sameAuthor: boolean;
}

/** The live prints whose current whole-print hash is `printId`'s (from JOIN_MIN_SIZE up), oldest first. */
export const identicalCopiesStatement = (db: D1Database, printId: string) =>
	db
		.prepare(
			`SELECT p.id AS id, p.title AS title, p.author_name AS author_name,
				(p.author_id IS NOT NULL AND p.source = o.source AND p.author_id = o.author_id) AS same_author
			FROM print_fingerprints f
			JOIN print_fingerprints g ON g.kind = 'print' AND g.sha256 = f.sha256 AND g.current = 1 AND g.print_id != f.print_id
			JOIN prints p ON p.id = g.print_id JOIN prints o ON o.id = f.print_id
			WHERE f.print_id = ? AND f.kind = 'print' AND f.current = 1 AND f.size >= ?
			ORDER BY p.created_at, p.id`
		)
		.bind(printId, JOIN_MIN_SIZE);

export const toIdenticalCopies = (rows: readonly Record<string, unknown>[]): IdenticalCopy[] =>
	rows.map((r) => ({
		id: String(r.id),
		title: String(r.title),
		author_name: (r.author_name as string | null) ?? null,
		sameAuthor: r.same_author === 1
	}));

/**
 * The hashes a block check looks at: the whole print's only (user, 2026-10-30). A removed book blocks its
 * own content and each of its pages (`fingerprintBlockValues`), so a page posted alone (a print whose
 * whole hash is that page's) is refused, but a book that merely holds the page is not.
 */
export const blockHashes = (fp: PrintFingerprint): string[] => (fp.whole ? [fp.whole.exact] : []);
