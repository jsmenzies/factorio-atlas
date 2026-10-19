import { Context, Effect, Layer } from 'effect';
import { nicknamesFor } from '#lib/aliases.js';
import type { PrintAnalysis } from './analyze';
import { buildingsIn } from './buildings';
import { StorageError } from './errors';
import type { FirebaseRecord } from './record';
import { toEpochMs } from './record';

/**
 * Version of what `upsert` writes to D1 for a print: the search index (`facetTokens`, FTS columns,
 * `print_items`, `print_uses`) and card columns, all derived from the record and its analysis.
 * Bump it when that changes: the next run rewrites only the D1 rows of every print, from the
 * analysis document already in R2, with no re-analysis and no R2 writes (`planIngest`'s 'refresh').
 * 1: `uses_entity_*`, `recipe_*` and `module_*` tokens, and `print_uses` (migration 0009).
 */
export const INDEX_VERSION = 1;

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
}

export interface FailedPrint {
	readonly id: string;
	readonly contentSha256: string;
	readonly reason: string;
	readonly favorites: number;
}

export class PrintRepository extends Context.Service<
	PrintRepository,
	{
		/** Store an analysed print and mark it 'ok' in `ingest_state`, in one batch. Returns D1 rows written. */
		readonly upsert: (p: StoredPrint) => Effect.Effect<number, StorageError>;
		readonly getState: (id: string) => Effect.Effect<IngestState | null, StorageError>;
		/** Track a record that couldn't be parsed or decoded, so it's skipped until it changes. */
		readonly recordFailure: (f: FailedPrint) => Effect.Effect<void, StorageError>;
		/** Only the favourites count changed: two small updates instead of a re-analysis. */
		readonly updateFavorites: (id: string, favorites: number) => Effect.Effect<void, StorageError>;
		/** The viewer files were rebuilt without re-analysing: one small `ingest_state` update. */
		readonly setViewerVersion: (id: string, viewerVersion: number) => Effect.Effect<void, StorageError>;
		/** Recompute the unfiltered sidebar counts and bump `sync_version`; run once after a batch of writes. */
		readonly rebuildFacets: () => Effect.Effect<void, StorageError>;
	}
>()('PrintRepository') {}

const json = (v: unknown) => JSON.stringify(v);
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
 * Keyword tokens for the FTS `facets` column. Every search filter is one of these, so text plus
 * any mix of filters resolves in a single FTS lookup (see `matchExpression` in queries.ts).
 */
export const facetTokens = (r: Pick<FirebaseRecord, 'tags'>, a: PrintAnalysis): string[] => {
	const tokens = new Set<string>([
		...a.outputs.map((s) => `makes_${slug(s)}`),
		...a.inputs.map((s) => `takes_${slug(s)}`),
		...[a.gameVersion, ...a.claimedVersions].flatMap((v) => (v ? versionTokens(v) : [])),
		a.requiresSpaceAge ? 'sa_yes' : 'sa_no',
		...(a.usesCircuits ? ['uses_circuits'] : []),
		...(a.usesTrains ? ['uses_trains'] : []),
		...(r.tags ?? []).map((t) => `tag_${slug(t)}`),
		...a.planets.map((p) => `planet_${slug(p)}`),
		...a.mods.map((m) => `mod_${slug(m)}`),
		// Every entity, recipe and module, not just what the UI offers today, so a new filter on
		// any of them needs no re-index. `uses_entity_` keeps them apart from uses_circuits/uses_trains.
		...Object.keys(a.entities).map((e) => `uses_${slug(`entity:${e}`)}`),
		...Object.keys(a.recipes).map((n) => `recipe_${slug(n)}`),
		...Object.keys(a.modules).map((m) => `module_${slug(m.split('@')[0])}`)
	]);
	return [...tokens].filter((t) => !t.endsWith('_'));
};

/**
 * The `facets` column: tokens in `facetTokens` order, cut at a token boundary under the FTS cap. The
 * biggest real books need about 16 KB; past the cap only the last tokens (recipes, modules) drop.
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
}

const toState = (row: StateRow): IngestState => ({
	contentSha256: row.content_sha256,
	status: row.status,
	reason: row.reason,
	analyzerVersion: row.analyzer_version,
	gameDataVersion: row.game_data_version,
	viewerVersion: row.viewer_version,
	indexVersion: row.index_version,
	favorites: row.favorites
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
			.prepare(`SELECT ${STATE_COLUMNS} FROM ingest_state WHERE print_id > ? ORDER BY print_id LIMIT ?`)
			.bind(after, pageSize)
			.all<StateRow>();
		for (const row of results) states.set(row.print_id, toState(row));
		if (results.length < pageSize) return states;
		after = results[results.length - 1].print_id;
	}
};

export interface PrintRepositoryHooks {
	/** Called with D1's `meta.rows_written` after every write, e.g. to total a run's writes. */
	readonly onWrite?: (op: 'upsert' | 'recordFailure' | 'updateFavorites' | 'setViewerVersion' | 'rebuildFacets', rows: number) => void;
}

export const PrintRepositoryD1 = (db: D1Database, hooks: PrintRepositoryHooks = {}) => {
	const counted =
		(op: Parameters<NonNullable<PrintRepositoryHooks['onWrite']>>[0]) =>
		(results: D1Result | D1Result[]): number => {
			const rows = rowsWritten(Array.isArray(results) ? results : [results]);
			hooks.onWrite?.(op, rows);
			return rows;
		};
	return Layer.succeed(PrintRepository, {
		getState: (id) =>
			tryD1(`d1.getState ${id}`, async () => {
				const row = await db.prepare(`SELECT ${STATE_COLUMNS} FROM ingest_state WHERE print_id = ?`).bind(id).first<StateRow>();
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
				db.batch([
					db.prepare('DELETE FROM facet_counts'),
					db.prepare(
						`INSERT INTO facet_counts (kind, value, n)
						SELECT 'makes', item, COUNT(*) FROM print_items WHERE role = 'output' GROUP BY item`
					),
					db.prepare(
						`INSERT INTO facet_counts (kind, value, n)
						SELECT 'version', v.value, COUNT(*) FROM prints p, json_each(p.claimed_versions) v GROUP BY v.value`
					),
					db.prepare(`INSERT INTO facet_counts (kind, value, n) SELECT 'uses', entity, COUNT(*) FROM print_uses GROUP BY entity`),
					db
						.prepare(
							`INSERT INTO meta (key, value) VALUES ('sync_version', ?)
							ON CONFLICT (key) DO UPDATE SET value = excluded.value`
						)
						.bind(String(Date.now()))
				])
			).pipe(Effect.map(counted('rebuildFacets')), Effect.asVoid),
		upsert: ({ id, sourceUrl, rawKey, rawSha256, contentSha256, record: r, analysis: a, viewerVersion }) =>
			tryD1(`d1.upsert ${id}`, async () => {
				const now = Date.now();
				const items = [
					...new Set(a.outputs.map((item) => `output\u0000${item}`)),
					...new Set(a.inputs.map((item) => `input\u0000${item}`))
				].map((k) => [id, ...k.split('\u0000')]);
				const stmts: D1PreparedStatement[] = [
					db.prepare('DELETE FROM print_items WHERE print_id = ?').bind(id),
					db.prepare('DELETE FROM print_uses WHERE print_id = ?').bind(id),
					db.prepare('DELETE FROM print_search WHERE print_id = ?').bind(id),
					db
						.prepare(
							`INSERT INTO prints (id, source, source_url, title, author_id, author_name, favorites, image_id, image_type,
								created_at, updated_at, raw_key, raw_sha256, ingested_at, analyzer_version, root_kind, game_version, game_major,
								blueprint_count, entity_count, requires_space_age, uses_circuits, uses_trains, outputs, claimed_versions, planets, mods)
							VALUES (?, 'factorioprints', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
							ON CONFLICT (id) DO UPDATE SET source_url = excluded.source_url, title = excluded.title,
								author_id = excluded.author_id, author_name = excluded.author_name, favorites = excluded.favorites,
								image_id = excluded.image_id, image_type = excluded.image_type, created_at = excluded.created_at,
								updated_at = excluded.updated_at, raw_key = excluded.raw_key, raw_sha256 = excluded.raw_sha256,
								ingested_at = excluded.ingested_at, analyzer_version = excluded.analyzer_version, root_kind = excluded.root_kind,
								game_version = excluded.game_version, game_major = excluded.game_major, blueprint_count = excluded.blueprint_count,
								entity_count = excluded.entity_count, requires_space_age = excluded.requires_space_age,
								uses_circuits = excluded.uses_circuits, uses_trains = excluded.uses_trains, outputs = excluded.outputs,
								claimed_versions = excluded.claimed_versions, planets = excluded.planets, mods = excluded.mods`
						)
						.bind(
							id,
							sourceUrl,
							r.title,
							r.author?.userId ?? r.authorId ?? null,
							r.author?.displayName ?? null,
							r.numberOfFavorites ?? 0,
							r.image?.id ?? null,
							r.image?.type ?? null,
							toEpochMs(r.createdDate),
							toEpochMs(r.lastUpdatedDate),
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
							json(a.claimedVersions),
							json(a.planets),
							json(a.mods)
						),
					...multiInsert(db, 'INSERT INTO print_items (print_id, role, item)', items),
					...multiInsert(
						db,
						'INSERT INTO print_uses (print_id, entity)',
						buildingsIn(Object.keys(a.entities)).map((entity) => [id, entity])
					),
					db
						.prepare(
							'INSERT INTO print_search (print_id, title, description, labels, entities, recipes, nicknames, facets) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
						)
						.bind(
							id,
							r.title,
							cap(r.descriptionMarkdown ?? ''),
							cap([...a.labels, ...a.nodes.map((n) => n.description ?? '')].join('\n')),
							cap(Object.keys(a.entities).join(' ').replaceAll('-', ' ')),
							cap([...Object.keys(a.recipes), ...a.outputs.map((o) => o.split(':')[1])].join(' ').replaceAll('-', ' ')),
							cap(nicknameText(a)),
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
					})
				];
				return counted('upsert')(await db.batch(stmts));
			})
	});
};
