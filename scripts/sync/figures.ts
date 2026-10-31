/**
 * The stage's counts for the Overview (SyncFigures): read in one batch from its D1, through the
 * backfill's bindings (remote for prod), plus each polled site's admission ledger (what the stage was given) and,
 * for a deployed stage, its R2 storage (r2-storage.ts).
 *
 * Every statement is a scan with primary-key lookups or one GROUP BY: no correlated subquery on an unindexed column
 * (prints.image_id has no index; the unused screenshots are a NOT IN over one list).
 */
import { siteOfPrintIdSql } from '#lib/print-id.js';
import { ANALYZER_VERSION } from '#lib/server/pipeline/analyze.js';
import { POLLED_SITES, type SourceFigures, type SyncFigures } from '#lib/sync.js';
import { recordsDir } from '../records/store';
import { openStage } from '../stage-command';
import { accountId, type Stage } from '../backfill/stage';
import { inboxDir, readLedger } from './polled';
import { readR2Storage } from './r2-storage';

const ROOT = new URL('../..', import.meta.url).pathname;

const count = (r: D1Result) => Number((r.results[0] as { n: number } | undefined)?.n ?? 0);
const byKey = (r: D1Result) => Object.fromEntries((r.results as { k: string | number; n: number }[]).map((x) => [String(x.k), x.n]));

/** Prints by the site they are credited to. Screenshots and ingest_state are joined by primary key. */
export const BY_SOURCE_SQL = `SELECT p.source AS site, count(*) AS prints, count(p.duplicate_of) AS folded,
	coalesce(sum(i.analyzer_version = ?), 0) AS analysed,
	coalesce(sum(coalesce(p.author_name, '') <> ''), 0) AS named,
	coalesce(sum(s.state = 'copied'), 0) AS shot
FROM prints p
LEFT JOIN screenshots s ON s.image_id = p.image_id
LEFT JOIN ingest_state i ON i.print_id = p.id
GROUP BY p.source`;

/** Live posts by site, and how many belong to a print credited elsewhere or repeat one credited here. */
export const POSTS_SQL = `SELECT ps.site AS site, count(*) AS posts,
	coalesce(sum(p.source <> ps.site), 0) AS other,
	coalesce(sum(p.source = ps.site), 0) AS own,
	count(DISTINCT CASE WHEN p.source = ps.site THEN ps.print_id END) AS own_prints
FROM print_sources ps
JOIN prints p ON p.id = ps.print_id
WHERE ps.gone_at IS NULL
GROUP BY ps.site`;

/** Records the ingest couldn't decode, by the site their id names (the backfill's: factorioprints). */
export const FAILED_SQL = `SELECT ${siteOfPrintIdSql('print_id')} AS site, count(*) AS n FROM ingest_state WHERE status = 'failed' GROUP BY 1`;

/** Prints credited to another site than their id names. */
export const CREDIT_SQL = `SELECT id, source FROM prints WHERE source <> ${siteOfPrintIdSql('id')}`;

/** Screenshot copies no print shows. */
export const UNUSED_SHOTS_SQL = `SELECT count(*) AS n FROM screenshots
WHERE state = 'copied' AND image_id NOT IN (SELECT image_id FROM prints WHERE image_id IS NOT NULL)`;

type BySourceRow = { site: string; prints: number; folded: number; analysed: number; named: number; shot: number };
type PostsRow = { site: string; posts: number; other: number; own: number; own_prints: number };

/** Posts in a polled site's ledger (given to the stage) that have no print_sources row: refused at the gate. */
export const refusedPosts = (ledgerIds: Iterable<string>, stageIds: Set<string>) => {
	let n = 0;
	for (const id of ledgerIds) if (!stageIds.has(id)) n++;
	return n;
};

/**
 * SourceFigures by site from the statements' rows. `unreadable` is the ingest's failures plus each polled site's
 * refusals, null for sites where nothing records them.
 */
export function assembleSources(
	bySource: BySourceRow[],
	posts: PostsRow[],
	failed: Record<string, number>,
	refused: Record<string, number>
): Record<string, SourceFigures> {
	const sites = new Set([...bySource.map((r) => r.site), ...posts.map((r) => r.site), ...Object.keys(failed), ...Object.keys(refused)]);
	const out: Record<string, SourceFigures> = {};
	for (const site of sites) {
		const p = bySource.find((r) => r.site === site);
		const q = posts.find((r) => r.site === site);
		const tracked = site in failed || site in refused || site === 'factorioprints';
		out[site] = {
			prints: p?.prints ?? 0,
			folded: p?.folded ?? 0,
			analysed: p?.analysed ?? 0,
			named: p?.named ?? 0,
			shot: p?.shot ?? 0,
			posts: q?.posts ?? 0,
			dupOther: q?.other ?? 0,
			dupSame: q ? q.own - q.own_prints : 0,
			unreadable: tracked ? (failed[site] ?? 0) + (refused[site] ?? 0) : null
		};
	}
	return out;
}

export const figureStatements = (db: D1Database) => {
	const polled = POLLED_SITES.map((p) => p.site);
	return [
		db.prepare('SELECT count(*) AS n FROM prints'),
		db.prepare("SELECT analyzer_version AS k, count(*) AS n FROM ingest_state WHERE status = 'ok' GROUP BY analyzer_version"),
		db.prepare("SELECT count(*) AS n FROM ingest_state WHERE status = 'failed'"),
		// Only factorioprints authors can be named (the authors step); other sites' anonymous posts never can.
		db.prepare("SELECT count(*) AS n FROM prints WHERE author_name IS NULL AND source = 'factorioprints'"),
		db.prepare('SELECT count(*) AS n FROM print_renders'),
		db.prepare('SELECT state AS k, count(*) AS n FROM screenshots GROUP BY state'),
		// Scalar subqueries in one row: D1 refuses compound SELECTs past a few terms.
		db.prepare(
			`SELECT (SELECT count(*) FROM reports WHERE status = 'open') AS reports,
			(SELECT count(*) FROM upload_images WHERE status = 'pending') AS screenshots,
			(SELECT count(*) FROM users WHERE deleting_at IS NOT NULL) AS deleting,
			(SELECT count(*) FROM uploads WHERE state = 'processing') AS processing`
		),
		db.prepare(BY_SOURCE_SQL).bind(ANALYZER_VERSION),
		db.prepare(POSTS_SQL),
		db.prepare(FAILED_SQL),
		db.prepare(`SELECT site, site_id FROM print_sources WHERE site IN (${polled.map(() => '?').join(', ')})`).bind(...polled),
		db.prepare(CREDIT_SQL),
		db.prepare(UNUSED_SHOTS_SQL)
	];
};

/** The statements' results as SyncFigures (without `r2`). `ledgers` gives each polled site's ids the stage was given. */
export function parseFigures(stage: string, results: D1Result[], ledgers: Record<string, string[]>, at = Date.now()): SyncFigures {
	const [prints, analysed, failed, unnamed, rendered, screenshots, attention, bySource, posts, failedBySite, polledIds, credit, unused] =
		results;
	const stageIds = new Map<string, Set<string>>();
	for (const r of polledIds.results as { site: string; site_id: string }[]) {
		if (!stageIds.has(r.site)) stageIds.set(r.site, new Set());
		stageIds.get(r.site)!.add(r.site_id);
	}
	const refused = Object.fromEntries(
		Object.entries(ledgers).map(([site, ids]) => [site, refusedPosts(ids, stageIds.get(site) ?? new Set())])
	);
	return {
		at,
		stage,
		prints: count(prints),
		analysed: byKey(analysed),
		failed: count(failed),
		unnamed: count(unnamed),
		rendered: count(rendered),
		screenshots: byKey(screenshots),
		attention: attention.results[0] as NonNullable<SyncFigures['attention']>,
		sources: assembleSources(
			bySource.results as BySourceRow[],
			posts.results as PostsRow[],
			Object.fromEntries((failedBySite.results as { site: string; n: number }[]).map((r) => [r.site, r.n])),
			refused
		),
		credit: Object.fromEntries((credit.results as { id: string; source: string }[]).map((r) => [r.id, r.source])),
		unusedShots: count(unused)
	};
}

export async function readFigures(stage: Stage): Promise<SyncFigures> {
	const inbox = inboxDir(recordsDir(ROOT));
	const ledgers = Object.fromEntries(
		await Promise.all(POLLED_SITES.map(async (p) => [p.site, Object.keys((await readLedger(inbox, p.site, stage)).records)] as const))
	);
	const target = await openStage(stage, undefined);
	let figures: SyncFigures;
	try {
		const db = target.env.DB;
		const results = await db.batch(figureStatements(db));
		figures = parseFigures(stage, results, ledgers);
		// What the count cost on the stage (stderr: --json keeps stdout to the result).
		console.error(
			`figures: ${results.reduce((n, r) => n + Number(r.meta?.rows_read ?? 0), 0).toLocaleString('en-GB')} rows read on ${stage}`
		);
	} finally {
		await target.dispose();
	}
	if (stage !== 'local') figures.r2 = await readR2Storage({ stage, account: accountId, token: process.env.ANALYTICS_API_TOKEN?.trim() });
	return figures;
}
