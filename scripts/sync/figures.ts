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
		const [prints, analysed, failed, unnamed, rendered, screenshots] = await db.batch([
			db.prepare('SELECT count(*) AS n FROM prints'),
			db.prepare("SELECT analyzer_version AS k, count(*) AS n FROM ingest_state WHERE status = 'ok' GROUP BY analyzer_version"),
			db.prepare("SELECT count(*) AS n FROM ingest_state WHERE status = 'failed'"),
			db.prepare('SELECT count(*) AS n FROM prints WHERE author_name IS NULL'),
			db.prepare('SELECT count(*) AS n FROM print_renders'),
			db.prepare('SELECT state AS k, count(*) AS n FROM screenshots GROUP BY state')
		]);
		return {
			at: Date.now(),
			stage,
			prints: count(prints),
			analysed: byKey(analysed),
			failed: count(failed),
			unnamed: count(unnamed),
			rendered: count(rendered),
			screenshots: byKey(screenshots)
		};
	} finally {
		await target.dispose();
	}
}
