/**
 * The stage's counts for the Overview (SyncFigures): read in one batch from its D1, through the
 * backfill's bindings (remote for prod).
 */
import type { SyncFigures } from '#lib/sync.js';
import { openStage } from '../stage-command';
import type { Stage } from '../backfill/stage';

const count = (r: D1Result) => Number((r.results[0] as { n: number } | undefined)?.n ?? 0);
const byKey = (r: D1Result) => Object.fromEntries((r.results as { k: string | number; n: number }[]).map((x) => [String(x.k), x.n]));

export async function readFigures(stage: Stage): Promise<SyncFigures> {
	const target = await openStage(stage, undefined);
	try {
		const db = target.env.DB;
		const [prints, analysed, failed, unnamed, rendered, screenshots, bySource, sourceRecords, attention] = await db.batch([
			db.prepare('SELECT count(*) AS n FROM prints'),
			db.prepare("SELECT analyzer_version AS k, count(*) AS n FROM ingest_state WHERE status = 'ok' GROUP BY analyzer_version"),
			db.prepare("SELECT count(*) AS n FROM ingest_state WHERE status = 'failed'"),
			// Only factorioprints authors can be named (the authors step); other sites' anonymous posts never can.
			db.prepare("SELECT count(*) AS n FROM prints WHERE author_name IS NULL AND source = 'factorioprints'"),
			db.prepare('SELECT count(*) AS n FROM print_renders'),
			db.prepare('SELECT state AS k, count(*) AS n FROM screenshots GROUP BY state'),
			db.prepare('SELECT source AS k, count(*) AS n, count(duplicate_of) AS folded FROM prints GROUP BY source'),
			db.prepare('SELECT site AS k, count(*) AS n FROM print_sources WHERE gone_at IS NULL GROUP BY site'),
			// Scalar subqueries in one row: D1 refuses compound SELECTs past a few terms.
			db.prepare(
				`SELECT (SELECT count(*) FROM reports WHERE status = 'open') AS reports,
				(SELECT count(*) FROM upload_images WHERE status = 'pending') AS screenshots,
				(SELECT count(*) FROM users WHERE deleting_at IS NOT NULL) AS deleting,
				(SELECT count(*) FROM uploads WHERE state = 'processing') AS processing`
			)
		]);
		return {
			at: Date.now(),
			stage,
			prints: count(prints),
			analysed: byKey(analysed),
			failed: count(failed),
			unnamed: count(unnamed),
			rendered: count(rendered),
			screenshots: byKey(screenshots),
			bySource: Object.fromEntries(
				(bySource.results as { k: string; n: number; folded: number }[]).map((r) => [r.k, { prints: r.n, folded: r.folded }])
			),
			sourceRecords: byKey(sourceRecords),
			attention: attention.results[0] as NonNullable<SyncFigures['attention']>
		};
	} finally {
		await target.dispose();
	}
}
