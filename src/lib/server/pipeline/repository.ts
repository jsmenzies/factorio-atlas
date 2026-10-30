import { Context, Effect, Layer } from 'effect';
import { nicknamesFor } from '#lib/aliases.js';
import { QUALITY_LEVELS } from '#lib/quality.js';
import { isPrintRemoved } from '#lib/server/removal-blocks.js';
import type { PrintAnalysis } from './analyze.js';
import { buildingsIn } from './buildings.js';
import { gameData } from './game-data.js';
import { StorageError } from './errors.js';
import type { PrintFingerprint } from './identity.js';
import { bumpPageVersion } from '../page-cache.js';
import { blockedBy, identityStatements, sourcesOf, sourcesStatement, type PrintSourceRow } from './identity-db.js';
import {
	FOLDED_PREFIX_SQL,
	FOLDED_TOKEN,
	foldStatement,
	foldStatements,
	planAllFolds,
	planFold,
	type FoldMember,
	type FoldState
} from './fold.js';
import type { FirebaseRecord } from './record.js';
import { toEpochMs } from './record.js';
import type { SourceMeta } from './source-record.js';

/**
 * Version of what `upsert` writes to D1 for a print: the search index (`facetTokens`, FTS columns,
 * `print_items`, `print_uses`) and card columns, all derived from the record and its analysis.
 * Bump it when that changes: the next run rewrites only the D1 rows of every print, from the
 * analysis document already in R2, with no re-analysis and no R2 writes (`planIngest`'s 'refresh').
 * 1: `uses_entity_*`, `recipe_*` and `module_*` tokens, and `print_uses` (migration 0009).
 * (The `author` column and `by_*` token came with migration 0017, which wrote them into every row
 * itself, so they needed no bump. `listedVersions` changed only rows of records from other sites, which
 * no backfill revisits: uploads take it at their next ingest.)
 */
export const INDEX_VERSION = 1;

/** A print's identity rows (migration 0022): where the record came from and its content fingerprints. */
export interface Identity {
	readonly source: SourceMeta;
	readonly fingerprint: PrintFingerprint;
}

export interface StoredPrint {
	readonly id: string;
	readonly sourceUrl: string;
	readonly rawKey: string;
	readonly rawSha256: string;
	/** sha256 of the sanitised record without numberOfFavorites (see `fingerprint`). */
	readonly contentSha256: string;
	readonly record: FirebaseRecord;
	readonly analysis: PrintAnalysis;
	/** VIEWER_VERSION of the print's viewer files in R2, already written. */
	readonly viewerVersion: number;
	/** The record's own author name, else the `authors` table's (`resolveAuthorName`). */
	readonly authorName: string | null;
	/** Written in the same batch; null leaves the identity rows as they are (a re-index). */
	readonly identity: Identity | null;
}

/** What the pipeline last did with a record (`ingest_state`). */
export interface IngestState {
	readonly contentSha256: string;
	readonly status: 'ok' | 'failed';
	readonly reason: string | null;
	readonly analyzerVersion: number | null;
	readonly gameDataVersion: string | null;
	/** VIEWER_VERSION of the print's `viewer/<id>/` files; null when there are none. */
	readonly viewerVersion: number | null;
	/** INDEX_VERSION of the print's D1 rows; null for failed records and rows from before migration 0009. */
	readonly indexVersion: number | null;
	readonly favorites: number;
	/**
	 * Whether the print has its identity rows (a `print_sources` row, migration 0022). Only the D1
	 * loaders say; undefined counts as yes.
	 */
	readonly identified?: boolean;
}

export interface FailedPrint {
	readonly id: string;
	readonly contentSha256: string;
	readonly reason: string;
	readonly favorites: number;
}

/**
 * `prints.updated_at`, the "Recently updated" order (the home page's default; index prints_updated): the record's
 * updated date, else its posted date (factoriobin posts have no updated date, and never change), else the time it
 * was first admitted (`fromRecord` false: a re-ingest keeps the row's earlier value, so such a print doesn't
 * jump to the top on every re-index). A NULL would sort last for good. The print's document keeps the record's
 * own dates; the About tab shows "Updated" only from those.
 */
export const recentSortDate = (r: Pick<FirebaseRecord, 'createdDate' | 'lastUpdatedDate'>, now: number) => {
	const own = toEpochMs(r.lastUpdatedDate) ?? toEpochMs(r.createdDate);
	return { at: own ?? now, fromRecord: own !== null };
};

export class PrintRepository extends Context.Service<
	PrintRepository,
	{
		/**
		 * Store an analysed print and mark it 'ok' in `ingest_state`, in one batch with its identity rows
		 * and any `extra` statements. Returns D1 rows written.
		 */
		readonly upsert: (p: StoredPrint, extra?: readonly D1PreparedStatement[]) => Effect.Effect<number, StorageError>;
		/**
		 * Write only a print's identity rows (one ingested before migration 0022, or a later source of a
		 * print another source is credited for), with any `extra` statements in the same batch.
		 */
		readonly identify: (id: string, identity: Identity, extra?: readonly D1PreparedStatement[]) => Effect.Effect<void, StorageError>;
		/** The soft-fold groups a print touches, as they should be (fold.ts); reads only. */
		readonly planFold: (id: string) => Effect.Effect<FoldMember[], StorageError>;
		/** Every soft-fold group in the stage, as it should be (fold.ts); reads only. */
		readonly planAllFolds: () => Effect.Effect<FoldMember[], StorageError>;
		/** Write the members whose fold changed, and with `bump` bump the page cache when any did. */
		readonly applyFold: (members: readonly FoldMember[], bump: boolean) => Effect.Effect<void, StorageError>;
		/**
		 * What a print's R2 document takes from D1 besides its record and analysis, in one round trip: its fold
		 * as its row has it now (both null for a print not stored yet) and every source (`sourcesOf`).
		 */
		readonly docState: (id: string) => Effect.Effect<{ fold: FoldState; sources: PrintSourceRow[] }, StorageError>;
		/** Purge every cached page (`bumpPageVersion`), after an R2 document changed outside an ingest batch. */
		readonly bumpPages: () => Effect.Effect<void, StorageError>;
		/** Every source of a print, live and gone (identity-db.ts `sourcesOf`). */
		readonly sources: (id: string) => Effect.Effect<PrintSourceRow[], StorageError>;
		/** The removed print whose block refuses the source or any of the hashes (identity-db.ts `blockedBy`), or null. */
		readonly blocked: (source: SourceMeta, hashes: readonly string[]) => Effect.Effect<string | null, StorageError>;
		readonly getState: (id: string) => Effect.Effect<IngestState | null, StorageError>;
		/** Track a record that couldn't be parsed or decoded, so it's skipped until it changes. */
		readonly recordFailure: (f: FailedPrint) => Effect.Effect<void, StorageError>;
		/** Only the favourites count changed: two small updates instead of a re-analysis. */
		readonly updateFavorites: (id: string, favorites: number) => Effect.Effect<void, StorageError>;
		/** The viewer files were rebuilt without re-analysing: one small `ingest_state` update. */
		readonly setViewerVersion: (id: string, viewerVersion: number) => Effect.Effect<void, StorageError>;
		/** Recompute the unfiltered sidebar counts and bump `sync_version`; run once after a batch of writes. */
		readonly rebuildFacets: () => Effect.Effect<void, StorageError>;
		/** The `authors` table's name for an author id (migration 0017), or null. */
		readonly authorName: (authorId: string) => Effect.Effect<string | null, StorageError>;
		/** Whether an approved removal blocks the print (`removal_blocks`, migration 0021). */
		readonly isRemoved: (id: string) => Effect.Effect<boolean, StorageError>;
	}
>()('PrintRepository') {}

const json = (v: unknown) => JSON.stringify(v);
/** Folded copies' ids (fold.ts), by the partial index on `duplicate_of`. */
const FOLDED_IDS = 'SELECT id FROM prints WHERE duplicate_of IS NOT NULL';
const flag = (b: boolean) => (b ? 1 : 0);

/** FTS columns are capped so one huge description can't bloat the index or break a SQL import. */
const FTS_COLUMN_MAX = 32 * 1024;
const cap = (s: string) => (s.length > FTS_COLUMN_MAX ? s.slice(0, FTS_COLUMN_MAX) : s);

/** "item:iron-plate" → "item_iron_plate"; "/general/early game/" → "general_early_game". */
export const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');

/** "2.0.55" → ["v_2", "v_2_0", "v_2_0_55"], so a filter on "2.0" matches every 2.0.x print. */
export const versionTokens = (version: string) => {
	const parts = version.split('.').filter((p) => /^\d+$/.test(p));
	return parts.map((_, i) => `v_${parts.slice(0, i + 1).join('_')}`);
};

/**
 * The versions a print lists (`prints.claimed_versions`: the search sidebar's "Game version" counts and the
 * card's chips): what its labels claim. A record from another site (an upload) that claims none lists the
 * version its string was saved in, as "2.0", which its `v_` tokens from `gameVersion` already match. Only
 * factorioprints records go without: their rows stay as INDEX_VERSION 1 wrote them.
 */
export const listedVersions = (r: Pick<FirebaseRecord, 'source'>, a: Pick<PrintAnalysis, 'claimedVersions' | 'gameVersion'>): string[] => {
	if (a.claimedVersions.length || !r.source || r.source.site === 'factorioprints' || !a.gameVersion) return a.claimedVersions;
	const parts = a.gameVersion.split('.').filter((p) => /^\d+$/.test(p));
	return parts.length >= 2 ? [`${parts[0]}.${parts[1]}`] : [];
};

/** The record's author id (factorioprints user id: 28 letters and digits). */
export const authorIdOf = (r: Pick<FirebaseRecord, 'author' | 'authorId'>) => r.author?.userId ?? r.authorId ?? null;

/** The `?author=` filter's token; first in the column, so facetText's cap never drops it. */
export const authorToken = (authorId: string) => `by_${slug(authorId)}`;

/** Every module, in the game's order: the search sidebar's Modules list (`facet_counts` kind 'module'). */
export const MODULES = Object.keys(gameData.modules);

/** The facet token of prints with a module, and of prints with anything at a quality level. */
export const moduleToken = (module: string) => `module_${slug(module) || 'none'}`;
export const qualityToken = (level: string) => `quality_${slug(level)}`;

/** A filter token at one quality: `uses_entity_beacon` → `uses_entity_beacon_at_epic`. */
export const atQuality = (token: string, quality: string) => `${token}_at_${slug(quality)}`;

/** The `name@quality` keys of a count, as [name, quality]; plain (normal quality) keys are left out. */
const atQualities = (counts: Record<string, number>) =>
	Object.keys(counts).flatMap((k): [string, string][] => {
		const at = k.lastIndexOf('@');
		return at < 0 ? [] : [[k.slice(0, at), k.slice(at + 1)]];
	});

/**
 * Keyword tokens for the FTS `facets` column. Every search filter is one of these, so text plus
 * any mix of filters resolves in a single FTS lookup (see `matchExpression` in queries.ts).
 */
export const facetTokens = (r: Pick<FirebaseRecord, 'tags' | 'author' | 'authorId'>, a: PrintAnalysis): string[] => {
	const author = authorIdOf(r);
	const tokens = new Set<string>([
		...(author ? [authorToken(author)] : []),
		...a.outputs.map((s) => `makes_${slug(s)}`),
		...a.inputs.map((s) => `takes_${slug(s)}`),
		...[a.gameVersion, ...a.claimedVersions].flatMap((v) => (v ? versionTokens(v) : [])),
		a.requiresSpaceAge ? 'sa_yes' : 'sa_no',
		...(a.usesCircuits ? ['uses_circuits'] : []),
		...(a.usesTrains ? ['uses_trains'] : []),
		...(r.tags ?? []).map((t) => `tag_${slug(t)}`),
		...a.planets.map((p) => `planet_${slug(p)}`),
		...a.mods.map((m) => `mod_${slug(m)}`),
		// Every quality above normal on an entity, module or recipe (`?quality=`).
		...Object.keys(a.qualities).map(qualityToken),
		// Short lists before the long ones: facetText's cap cuts from the end, and the biggest modded books
		// reach it with thousands of entity and recipe names.
		...Object.keys(a.modules).map((m) => moduleToken(m.split('@')[0])),
		// Each entity, module and crafted item at each quality above normal it has, for `?uses=entity:beacon@epic`
		// and the like. Documents from before ANALYZER_VERSION 9 have no productsByQuality.
		...atQualities(a.entitiesByQuality).map(([name, q]) => atQuality(`uses_${slug(`entity:${name}`)}`, q)),
		...atQualities(a.modules).map(([name, q]) => atQuality(moduleToken(name), q)),
		...atQualities(a.productsByQuality ?? {}).map(([signal, q]) => atQuality(`makes_${slug(signal)}`, q)),
		// Every entity and recipe, not just what the UI offers today, so a new filter on any of them
		// needs no re-index. `uses_entity_` keeps them apart from uses_circuits/uses_trains.
		...Object.keys(a.entities).map((e) => `uses_${slug(`entity:${e}`)}`),
		...Object.keys(a.recipes).map((n) => `recipe_${slug(n)}`)
	]);
	return [...tokens].filter((t) => !t.endsWith('_'));
};

/**
 * The facet token of prints with a game render in the stage's RENDERS bucket (`?render=1`). Not
 * from the analysis: print_renders (migration 0015, written by `bun run render:flags`) says which
 * prints have one, `upsert` adds it while that row exists, and render-flags.ts patches the FTS
 * rows of prints the sync sets or unsets. First in the column, so facetText's cap never drops it.
 */
export const RENDER_TOKEN = 'render_yes';

/**
 * The `facets` column: tokens in `facetTokens` order, cut at a token boundary under the FTS cap. The
 * biggest books need about 16 KB, except three huge modded ones that reach it (2026-10-24); past the
 * cap only the last tokens, entities and recipes, drop.
 */
export const facetText = (tokens: string[]) => {
	const kept: string[] = [];
	let length = -1;
	for (const t of tokens) {
		if (length + 1 + t.length > FTS_COLUMN_MAX) break;
		kept.push(t);
		length += 1 + t.length;
	}
	return kept.join(' ');
};

/** Nicknames of everything in the print, so "red science" finds automation science packs. */
const nicknameText = (a: PrintAnalysis) => {
	const names = new Set([
		...[...a.outputs, ...a.inputs].map((s) => s.slice(s.indexOf(':') + 1)),
		...Object.keys(a.recipes),
		...Object.keys(a.entities),
		...Object.keys(a.modules).map((m) => m.split('@')[0])
	]);
	return [...names].flatMap(nicknamesFor).join(' | ');
};

/** Rows for a multi-row INSERT, chunked to stay under D1's 100 bound parameters per statement. */
const multiInsert = (db: D1Database, head: string, rows: unknown[][]) => {
	if (rows.length === 0) return [];
	const perRow = rows[0].length;
	const per = Math.floor(100 / perRow);
	const out: D1PreparedStatement[] = [];
	for (let i = 0; i < rows.length; i += per) {
		const chunk = rows.slice(i, i + per);
		const values = chunk.map(() => `(${Array(perRow).fill('?').join(', ')})`).join(', ');
		out.push(db.prepare(`${head} VALUES ${values}`).bind(...chunk.flat()));
	}
	return out;
};

const stateRow = (
	db: D1Database,
	s: {
		id: string;
		contentSha256: string;
		status: 'ok' | 'failed';
		reason: string | null;
		analyzerVersion: number | null;
		gameDataVersion: string | null;
		viewerVersion: number | null;
		indexVersion: number | null;
		favorites: number;
	}
) =>
	db
		.prepare(
			`INSERT OR REPLACE INTO ingest_state (print_id, content_sha256, status, reason, analyzer_version, game_data_version, viewer_version,
				index_version, favorites, checked_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			s.id,
			s.contentSha256,
			s.status,
			s.reason,
			s.analyzerVersion,
			s.gameDataVersion,
			s.viewerVersion,
			s.indexVersion,
			s.favorites,
			Date.now()
		);

const tryD1 = <A>(op: string, run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: (cause) => new StorageError({ op, cause }) });

const rowsWritten = (results: D1Result[]) => results.reduce((n, r) => n + (r.meta?.rows_written ?? 0), 0);

const STATE_COLUMNS =
	'print_id, content_sha256, status, reason, analyzer_version, game_data_version, viewer_version, index_version, favorites';
/** STATE_COLUMNS plus whether the print has identity rows (one index lookup per row). */
const STATE_SELECT = `${STATE_COLUMNS}, EXISTS (SELECT 1 FROM print_sources s WHERE s.print_id = ingest_state.print_id) AS identified`;

interface StateRow {
	print_id: string;
	content_sha256: string;
	status: 'ok' | 'failed';
	reason: string | null;
	analyzer_version: number | null;
	game_data_version: string | null;
	viewer_version: number | null;
	index_version: number | null;
	favorites: number;
	identified?: number;
}

const toState = (row: StateRow): IngestState => ({
	contentSha256: row.content_sha256,
	status: row.status,
	reason: row.reason,
	analyzerVersion: row.analyzer_version,
	gameDataVersion: row.game_data_version,
	viewerVersion: row.viewer_version,
	indexVersion: row.index_version,
	favorites: row.favorites,
	...(row.identified === undefined ? {} : { identified: row.identified === 1 })
});

/**
 * Every `ingest_state` row, keyed by print id, in pages of `pageSize`: a bulk run looks each record
 * up here instead of one `getState` round trip per print.
 */
export const loadIngestStates = async (db: D1Database, pageSize = 5000): Promise<Map<string, IngestState>> => {
	const states = new Map<string, IngestState>();
	let after = '';
	for (;;) {
		const { results } = await db
			.prepare(`SELECT ${STATE_SELECT} FROM ingest_state WHERE print_id > ? ORDER BY print_id LIMIT ?`)
			.bind(after, pageSize)
			.all<StateRow>();
		for (const row of results) states.set(row.print_id, toState(row));
		if (results.length < pageSize) return states;
		after = results[results.length - 1].print_id;
	}
};

/** Every named author in the `authors` table (migration 0017), in pages by primary key. */
export const loadAuthorNames = async (db: D1Database, pageSize = 5000): Promise<Map<string, string>> => {
	const names = new Map<string, string>();
	for (let after = ''; ;) {
		const { results } = await db
			.prepare('SELECT author_id, display_name FROM authors WHERE author_id > ? ORDER BY author_id LIMIT ?')
			.bind(after, pageSize)
			.all<{ author_id: string; display_name: string | null }>();
		for (const r of results) if (r.display_name) names.set(r.author_id, r.display_name);
		if (results.length < pageSize) return names;
		after = results[results.length - 1].author_id;
	}
};

export interface PrintRepositoryHooks {
	/** Called with D1's `meta.rows_written` after every write, e.g. to total a run's writes. */
	readonly onWrite?: (
		op: 'upsert' | 'recordFailure' | 'updateFavorites' | 'setViewerVersion' | 'rebuildFacets' | 'identify' | 'fold',
		rows: number
	) => void;
}

export const PrintRepositoryD1 = (db: D1Database, hooks: PrintRepositoryHooks = {}) => {
	const counted =
		(op: Parameters<NonNullable<PrintRepositoryHooks['onWrite']>>[0]) =>
		(results: D1Result | D1Result[]): number => {
			const rows = rowsWritten(Array.isArray(results) ? results : [results]);
			hooks.onWrite?.(op, rows);
			return rows;
		};
	// Read once, on the first print that needs it: a bulk run then looks names up in memory.
	let authors: Promise<Map<string, string>> | undefined;
	return Layer.succeed(PrintRepository, {
		authorName: (authorId) =>
			tryD1(`d1.authorName ${authorId}`, async () => (await (authors ??= loadAuthorNames(db))).get(authorId) ?? null),
		isRemoved: (id) => tryD1(`d1.isRemoved ${id}`, () => isPrintRemoved(db, id)),
		identify: (id, { source, fingerprint }, extra = []) =>
			tryD1(`d1.identify ${id}`, () => db.batch([...identityStatements(db, id, source, fingerprint), ...extra])).pipe(
				Effect.map(counted('identify')),
				Effect.asVoid
			),
		planFold: (id) => tryD1(`d1.planFold ${id}`, () => planFold(db, id)),
		planAllFolds: () => tryD1('d1.planAllFolds', () => planAllFolds(db)),
		docState: (id) =>
			tryD1(`d1.docState ${id}`, async () => {
				const [fold, sources] = await db.batch([foldStatement(db, id), sourcesStatement(db, id)]);
				const row = (fold.results as { duplicate_of: string | null; identical_to: string | null }[])[0];
				return {
					fold: { duplicateOf: row?.duplicate_of ?? null, identicalTo: row?.identical_to ?? null },
					sources: sources.results as PrintSourceRow[]
				};
			}),
		bumpPages: () => tryD1('d1.bumpPages', () => bumpPageVersion(db).run()).pipe(Effect.asVoid),
		sources: (id) => tryD1(`d1.sources ${id}`, () => sourcesOf(db, id)),
		applyFold: (members, bump) =>
			tryD1('d1.applyFold', async () => {
				const stmts = foldStatements(db, members, { bump });
				return stmts.length ? db.batch(stmts) : [];
			}).pipe(Effect.map(counted('fold')), Effect.asVoid),
		blocked: (source, hashes) =>
			tryD1(`d1.blocked ${source.site}:${source.siteId}`, async () => (await blockedBy(db, source, hashes))?.printId ?? null),
		getState: (id) =>
			tryD1(`d1.getState ${id}`, async () => {
				const row = await db.prepare(`SELECT ${STATE_SELECT} FROM ingest_state WHERE print_id = ?`).bind(id).first<StateRow>();
				return row ? toState(row) : null;
			}),
		recordFailure: ({ id, contentSha256, reason, favorites }) =>
			tryD1(`d1.recordFailure ${id}`, () =>
				db.batch([
					// A print that used to decode and no longer does leaves the site.
					db.prepare('DELETE FROM print_search WHERE print_id = ?').bind(id),
					db.prepare('DELETE FROM prints WHERE id = ?').bind(id),
					stateRow(db, {
						id,
						contentSha256,
						status: 'failed',
						reason,
						analyzerVersion: null,
						gameDataVersion: null,
						viewerVersion: null,
						indexVersion: null,
						favorites
					})
				])
			).pipe(Effect.map(counted('recordFailure')), Effect.asVoid),
		updateFavorites: (id, favorites) =>
			tryD1(`d1.updateFavorites ${id}`, () =>
				db.batch([
					db.prepare('UPDATE prints SET favorites = ? WHERE id = ?').bind(favorites, id),
					db.prepare('UPDATE ingest_state SET favorites = ?, checked_at = ? WHERE print_id = ?').bind(favorites, Date.now(), id)
				])
			).pipe(Effect.map(counted('updateFavorites')), Effect.asVoid),
		setViewerVersion: (id, viewerVersion) =>
			tryD1(`d1.setViewerVersion ${id}`, () =>
				db
					.prepare('UPDATE ingest_state SET viewer_version = ?, checked_at = ? WHERE print_id = ?')
					.bind(viewerVersion, Date.now(), id)
					.run()
			).pipe(Effect.map(counted('setViewerVersion')), Effect.asVoid),
		rebuildFacets: () =>
			tryD1('d1.rebuildFacets', () =>
				// Folded copies (fold.ts) count nowhere, as they show nowhere in search.
				db.batch([
					db.prepare('DELETE FROM facet_counts'),
					db.prepare(
						`INSERT INTO facet_counts (kind, value, n)
						SELECT 'makes', item, COUNT(*) FROM print_items WHERE role = 'output' AND print_id NOT IN (${FOLDED_IDS}) GROUP BY item`
					),
					db.prepare(
						`INSERT INTO facet_counts (kind, value, n)
						SELECT 'version', v.value, COUNT(*) FROM prints p, json_each(p.claimed_versions) v WHERE p.duplicate_of IS NULL GROUP BY v.value`
					),
					db.prepare(
						`INSERT INTO facet_counts (kind, value, n)
						SELECT 'uses', entity, COUNT(*) FROM print_uses WHERE print_id NOT IN (${FOLDED_IDS}) GROUP BY entity`
					),
					// The Modules and "Quality in the print" lists: FTS counts of their tokens, once here rather than on every search.
					...[...MODULES.map((m) => ['module', m, moduleToken(m)]), ...QUALITY_LEVELS.map((q) => ['quality', q, qualityToken(q)])].map(
						([kind, value, token]) =>
							db
								.prepare(
									`INSERT INTO facet_counts (kind, value, n)
									VALUES (?1, ?2, (SELECT COUNT(*) FROM print_search WHERE print_search MATCH ?3))`
								)
								.bind(kind, value, `facets : "${token}" NOT facets : "${FOLDED_TOKEN}"`)
					),
					db
						.prepare(
							`INSERT INTO meta (key, value) VALUES ('sync_version', ?)
							ON CONFLICT (key) DO UPDATE SET value = excluded.value`
						)
						.bind(String(Date.now()))
				])
			).pipe(Effect.map(counted('rebuildFacets')), Effect.asVoid),
		upsert: (
			{ id, sourceUrl, rawKey, rawSha256, contentSha256, record: r, analysis: a, viewerVersion, authorName, identity },
			extra = []
		) =>
			tryD1(`d1.upsert ${id}`, async () => {
				const now = Date.now();
				const sortDate = recentSortDate(r, now);
				const authorId = authorIdOf(r);
				const ownName = r.author?.displayName || null;
				const items = [
					...new Set(a.outputs.map((item) => `output\u0000${item}`)),
					...new Set(a.inputs.map((item) => `input\u0000${item}`))
				].map((k) => [id, ...k.split('\u0000')]);
				const stmts: D1PreparedStatement[] = [
					// A print deleted as gone that is back (migration 0021). A takedown's tombstone stays: its blocks make
					// the `prints_not_removed` trigger refuse this whole batch anyway.
					db.prepare(`DELETE FROM print_tombstones WHERE print_id = ? AND kind = 'gone'`).bind(id),
					db.prepare('DELETE FROM print_items WHERE print_id = ?').bind(id),
					db.prepare('DELETE FROM print_uses WHERE print_id = ?').bind(id),
					db.prepare('DELETE FROM print_search WHERE print_id = ?').bind(id),
					db
						.prepare(
							`INSERT INTO prints (id, source, source_url, title, author_id, author_name, favorites, image_id, image_type,
								created_at, updated_at, raw_key, raw_sha256, ingested_at, analyzer_version, root_kind, game_version, game_major,
								blueprint_count, entity_count, requires_space_age, uses_circuits, uses_trains, outputs, claimed_versions, planets, mods)
							VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
							ON CONFLICT (id) DO UPDATE SET source = excluded.source, source_url = excluded.source_url, title = excluded.title,
								author_id = excluded.author_id, author_name = excluded.author_name, favorites = excluded.favorites,
								image_id = excluded.image_id, image_type = excluded.image_type, created_at = excluded.created_at,
								updated_at = ${sortDate.fromRecord ? 'excluded.updated_at' : 'COALESCE(prints.updated_at, excluded.updated_at)'}, raw_key = excluded.raw_key, raw_sha256 = excluded.raw_sha256,
								ingested_at = excluded.ingested_at, analyzer_version = excluded.analyzer_version, root_kind = excluded.root_kind,
								game_version = excluded.game_version, game_major = excluded.game_major, blueprint_count = excluded.blueprint_count,
								entity_count = excluded.entity_count, requires_space_age = excluded.requires_space_age,
								uses_circuits = excluded.uses_circuits, uses_trains = excluded.uses_trains, outputs = excluded.outputs,
								claimed_versions = excluded.claimed_versions, planets = excluded.planets, mods = excluded.mods`
						)
						.bind(
							id,
							r.source?.site ?? 'factorioprints',
							sourceUrl,
							r.title,
							authorId,
							authorName,
							r.numberOfFavorites ?? 0,
							r.image?.id ?? null,
							r.image?.type ?? null,
							toEpochMs(r.createdDate),
							sortDate.at,
							rawKey,
							rawSha256,
							now,
							a.analyzerVersion,
							a.rootKind,
							a.gameVersion,
							a.gameMajor,
							a.blueprintCount,
							a.entityCount,
							flag(a.requiresSpaceAge),
							flag(a.usesCircuits),
							flag(a.usesTrains),
							json(a.outputs),
							json(listedVersions(r, a)),
							json(a.planets),
							json(a.mods)
						),
					...multiInsert(db, 'INSERT INTO print_items (print_id, role, item)', items),
					...multiInsert(
						db,
						'INSERT INTO print_uses (print_id, entity)',
						buildingsIn(Object.keys(a.entities)).map((entity) => [id, entity])
					),
					// A record's own name names its author's other prints too (`bun run authors` spreads it).
					...(authorId && ownName
						? [
								db
									.prepare(
										`INSERT INTO authors (author_id, display_name, source, fetched_at) VALUES (?, ?, 'record', ?)
										ON CONFLICT (author_id) DO UPDATE SET display_name = excluded.display_name, source = excluded.source,
											fetched_at = excluded.fetched_at WHERE authors.display_name IS NULL`
									)
									.bind(authorId, ownName, now)
							]
						: []),
					db
						.prepare(
							`INSERT INTO print_search (print_id, title, description, labels, entities, recipes, nicknames, author, facets)
							VALUES (?, ?, ?, ?, ?, ?, ?, ?,
								CASE WHEN EXISTS (SELECT 1 FROM print_renders WHERE print_id = ?) THEN '${RENDER_TOKEN} ' ELSE '' END || ${FOLDED_PREFIX_SQL} || ?)`
						)
						.bind(
							id,
							r.title,
							cap(r.descriptionMarkdown ?? ''),
							cap([...a.labels, ...a.nodes.map((n) => n.description ?? '')].join('\n')),
							cap(Object.keys(a.entities).join(' ').replaceAll('-', ' ')),
							cap([...Object.keys(a.recipes), ...a.outputs.map((o) => o.split(':')[1])].join(' ').replaceAll('-', ' ')),
							cap(nicknameText(a)),
							authorName ?? '',
							id,
							id,
							facetText(facetTokens(r, a))
						),
					stateRow(db, {
						id,
						contentSha256,
						status: 'ok',
						reason: null,
						analyzerVersion: a.analyzerVersion,
						gameDataVersion: a.gameDataVersion,
						viewerVersion,
						indexVersion: INDEX_VERSION,
						favorites: r.numberOfFavorites ?? 0
					}),
					...(identity ? identityStatements(db, id, identity.source, identity.fingerprint, now) : []),
					...extra
				];
				const rows = counted('upsert')(await db.batch(stmts));
				if (authorId && ownName) void authors?.then((m) => m.has(authorId) || m.set(authorId, ownName));
				return rows;
			})
	});
};
