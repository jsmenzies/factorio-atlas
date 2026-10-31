/** `xs` in runs of at most `n`, e.g. to keep a statement's bound parameters under D1's 100. */
export const chunks = <T>(xs: readonly T[], n: number): T[][] =>
	Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Rows written by a batch's statements. */
export const rowsWritten = (results: readonly D1Result[]) => results.reduce((n, r) => n + (r.meta?.rows_written ?? 0), 0);

/**
 * Runs `stmts` in D1 batches of `size` statements (each batch is one transaction), in order, and
 * returns the rows written. `onBatch` hears statements done and the total after each batch.
 */
export async function runBatches(
	db: D1Database,
	stmts: readonly D1PreparedStatement[],
	size: number,
	onBatch?: (done: number, total: number) => void
): Promise<number> {
	let written = 0;
	for (let i = 0; i < stmts.length; i += size) {
		written += rowsWritten(await db.batch(stmts.slice(i, i + size)));
		onBatch?.(Math.min(i + size, stmts.length), stmts.length);
	}
	return written;
}
