/**
 * Full-run projections for a pipeline run, shared by the terminal (src/lib/server/pipeline/backfill.ts)
 * and /admin/pipeline. Pure and client-safe.
 */
import type { PipelineRun } from '#lib/server/pipeline/runs.js';

/** Workers Paid includes 50M D1 rows written a month (then $1 per million). */
export const D1_MONTHLY_ROWS = 50_000_000;
/** R2's free tier: 1M Class A operations (puts) a month, shared by every bucket in the account. */
export const R2_FREE_CLASS_A = 1_000_000;

/** Prints that wrote something: the base for per-print projections (skips write nothing). */
export const writers = (r: Pick<PipelineRun, 'analysed' | 'failed' | 'viewer' | 'reindexed' | 'favorites'>) =>
	// `reindexed` is missing from runs written before migration 0009.
	r.analysed + r.failed + r.viewer + (r.reindexed ?? 0) + r.favorites;

/**
 * A fresh load of the whole source, extrapolated from this run's writes. D1 rows are mostly a fixed
 * handful per print, so they scale per print. R2 objects and bytes grow with record size, so they
 * scale with the mirror bytes behind them: a size-spread `--limit` sample includes the biggest
 * books, and per-print averages would overshoot several times. Null before anything is written.
 */
export const fullRunEstimate = (
	run: Pick<
		PipelineRun,
		| 'analysed'
		| 'failed'
		| 'viewer'
		| 'reindexed'
		| 'favorites'
		| 'rows_written'
		| 'r2_objects'
		| 'r2_bytes'
		| 'source_bytes'
		| 'total'
		| 'options'
	>
) => {
	const n = writers(run);
	if (n === 0) return null;
	const prints = run.options.corpus ?? run.total;
	const byBytes = run.options.corpusBytes && run.source_bytes > 0 ? run.options.corpusBytes / run.source_bytes : null;
	const scale = byBytes ?? prints / n;
	return {
		prints,
		rowsPerPrint: run.rows_written / n,
		rows: (run.rows_written / n) * prints,
		objects: run.r2_objects * scale,
		bytes: run.r2_bytes * scale,
		byBytes: byBytes !== null
	};
};
