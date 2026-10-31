/**
 * The stage's counts for the Overview (SyncFigures): read in one batch from its D1, through the
 * backfill's bindings (remote for prod), plus each polled site's admission ledger (what the stage was given) and,
 * for a deployed stage, its R2 storage (r2-storage.ts).
 *
 * Every statement is a scan with primary-key lookups or one GROUP BY: no correlated subquery on an unindexed column
 * (prints.image_id has no index; the unused screenshots are a NOT IN over one list).
 */
import { existsSync } from 'node:fs';
import { printIdFor, siteOfPrintIdSql, type Site } from '#lib/print-id.js';
import { ANALYZER_VERSION } from '#lib/server/pipeline/analyze.js';
import { POLLED_SITES, type SourceFigures, type SyncFigures } from '#lib/sync.js';
import { recordsDir } from '../records/store';
import { openStage } from '../stage-command';
import { accountId, type Stage } from '../backfill/stage';
import { inboxDir, ledgerFile, readLedger, readState } from './polled';
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

/**
 * Posts a polled site's ledger says the stage was given (`ledger`: site id → revision, or 'gone' once its source
 * gone ran) that have no print_sources row: refused at the gate (unreadable, too big or blocked). Not counted: posts
 * gone from the site (`gone`, the inbox's poll state), and posts whose print has a failed ingest_state row
 * (`failedIds`: counted with the ingest's failures instead, so each post counts once).
 */
export const refusedPosts = (
	site: Site,
	ledger: Record<string, string>,
	stageIds: Set<string>,
	gone: Set<string> = new Set(),
	failedIds: Set<string> = new Set()
) => {
	let n = 0;
	for (const [id, rev] of Object.entries(ledger))
		if (rev !== 'gone' && !gone.has(id) && !stageIds.has(id) && !failedIds.has(printIdFor(site, id))) n++;
	return n;
};

/**
 * SourceFigures by site from the statements' rows. `unreadable` is the ingest's failures plus each polled site's
 * refusals (`refused`, null when this machine has no ledger for the stage), null where it isn't known: a polled site
 * with no ledger, and sites nothing records refusals for (factoriobin, uploads) unless the ingest failed one.
 */
export function assembleSources(
	bySource: BySourceRow[],
	posts: PostsRow[],
	failed: Record<string, number>,
	refused: Record<string, number | null>
): Record<string, SourceFigures> {
	const sites = new Set([...bySource.map((r) => r.site), ...posts.map((r) => r.site), ...Object.keys(failed), ...Object.keys(refused)]);
	const out: Record<string, SourceFigures> = {};
	for (const site of sites) {
		const p = bySource.find((r) => r.site === site);
		const q = posts.find((r) => r.site === site);
		const ledger = refused[site];
		const known = site in refused ? ledger !== null : site in failed || site === 'factorioprints';
		out[site] = {
			prints: p?.prints ?? 0,
			folded: p?.folded ?? 0,
			analysed: p?.analysed ?? 0,
			named: p?.named ?? 0,
			shot: p?.shot ?? 0,
			posts: q?.posts ?? 0,
			dupOther: q?.other ?? 0,
			dupSame: q ? q.own - q.own_prints : 0,
			unreadable: known ? (failed[site] ?? 0) + (ledger ?? 0) : null
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
		db.prepare("SELECT count(*) AS n FROM prints WHERE coalesce(author_name, '') = '' AND source = 'factorioprints'"),
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
		db
			.prepare(
				`SELECT print_id FROM ingest_state WHERE status = 'failed' AND ${siteOfPrintIdSql('print_id')} IN (${polled.map(() => '?').join(', ')})`
			)
			.bind(...polled),
		db.prepare(`SELECT site, site_id FROM print_sources WHERE site IN (${polled.map(() => '?').join(', ')})`).bind(...polled),
		db.prepare(CREDIT_SQL),
		db.prepare(UNUSED_SHOTS_SQL)
	];
};

/** What this machine knows of a polled site's posts for a stage: its ledger (null: none) and the ids gone from the site. */
export interface PolledLedger {
	ledger: Record<string, string> | null;
	gone: string[];
}

/**
 * The statements' results as SyncFigures (without `r2`) and the credit map (print id → credited site, for prints
 * whose id names another site), which is saved apart (sync_meta 'credit') so the figures stay a fixed size.
 */
export function parseFigures(
	stage: string,
	results: D1Result[],
	ledgers: Partial<Record<Site, PolledLedger>>,
	at = Date.now()
): { figures: SyncFigures; credit: Record<string, string> } {
	const [
		prints,
		analysed,
		failed,
		unnamed,
		rendered,
		screenshots,
		attention,
		bySource,
		posts,
		failedBySite,
		failedPolled,
		polledIds,
		credit,
		unused
	] = results;
	const failedIds = new Set((failedPolled.results as { print_id: string }[]).map((r) => r.print_id));
	const stageIds = new Map<string, Set<string>>();
	for (const r of polledIds.results as { site: string; site_id: string }[]) {
		if (!stageIds.has(r.site)) stageIds.set(r.site, new Set());
		stageIds.get(r.site)!.add(r.site_id);
	}
	const refused = Object.fromEntries(
		(Object.entries(ledgers) as [Site, PolledLedger][]).map(([site, l]) => [
			site,
			l.ledger ? refusedPosts(site, l.ledger, stageIds.get(site) ?? new Set(), new Set(l.gone), failedIds) : null
		])
	);
	const figures: SyncFigures = {
		at,
		stage,
		analyzerVersion: ANALYZER_VERSION,
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
		unusedShots: count(unused)
	};
	return { figures, credit: Object.fromEntries((credit.results as { id: string; source: string }[]).map((r) => [r.id, r.source])) };
}

export async function readFigures(stage: Stage): Promise<{ figures: SyncFigures; credit: Record<string, string> }> {
	const inbox = inboxDir(recordsDir(ROOT));
	const ledgers = Object.fromEntries(
		await Promise.all(
			POLLED_SITES.map(async (p): Promise<[Site, PolledLedger]> => [
				p.site,
				{
					ledger: existsSync(ledgerFile(inbox, p.site, stage)) ? (await readLedger(inbox, p.site, stage)).records : null,
					gone: Object.keys((await readState(inbox, p.site)).gone)
				}
			])
		)
	);
	const target = await openStage(stage, undefined);
	let out: { figures: SyncFigures; credit: Record<string, string> };
	try {
		const db = target.env.DB;
		const results = await db.batch(figureStatements(db));
		out = parseFigures(stage, results, ledgers);
		// What the count cost on the stage (stderr: --json keeps stdout to the result).
		console.error(
			`figures: ${results.reduce((n, r) => n + Number(r.meta?.rows_read ?? 0), 0).toLocaleString('en-GB')} rows read on ${stage}`
		);
	} finally {
		await target.dispose();
	}
	if (stage !== 'local')
		out.figures.r2 = await readR2Storage({ stage, account: accountId, token: process.env.ANALYTICS_API_TOKEN?.trim() });
	return out;
}
