/**
 * `removal_blocks` (migration 0021): what an approved removal stops from coming back. A factorioprints
 * print is blocked by its own id (`print`) and its source id (`source`, 'factorioprints:<id>'); other
 * sites and uploads add their own `source` and `sha256` blocks.
 */

export type BlockKind = 'print' | 'source' | 'sha256' | 'image';

export interface Block {
	readonly kind: BlockKind;
	readonly value: string;
}

export const FACTORIOPRINTS = 'factorioprints';

/** The message of migration 0021's `prints_not_removed` trigger, which refuses a blocked print's row. */
export const REMOVED_ABORT = 'print removed on request';

export const sourceBlock = (site: string, siteId: string): Block => ({ kind: 'source', value: `${site}:${siteId}` });

/** The blocks of a factorioprints print: its id here and on factorioprints (the same id). */
export const printBlocks = (id: string): Block[] => [{ kind: 'print', value: id }, sourceBlock(FACTORIOPRINTS, id)];

/** Whether a factorioprints print is blocked: one primary-key lookup per block. */
export const isPrintRemoved = async (db: D1Database, id: string): Promise<boolean> => {
	const blocks = printBlocks(id);
	const row = await db
		.prepare(`SELECT 1 AS hit FROM removal_blocks WHERE ${blocks.map(() => '(kind = ? AND value = ?)').join(' OR ')} LIMIT 1`)
		.bind(...blocks.flatMap((b) => [b.kind, b.value]))
		.first<{ hit: number }>();
	return row !== null;
};

/** Every blocked factorioprints id, for a run that checks thousands of prints (backfill, renders, screenshots). */
export const loadRemovedPrintIds = async (db: D1Database): Promise<Set<string>> => {
	const prefix = `${FACTORIOPRINTS}:`;
	// A range on the primary key: every 'source' value that starts with the prefix (';' follows ':').
	const { results } = await db
		.prepare(`SELECT kind, value FROM removal_blocks WHERE kind = 'print' OR (kind = 'source' AND value >= ? AND value < ?)`)
		.bind(prefix, `${FACTORIOPRINTS};`)
		.all<{ kind: BlockKind; value: string }>();
	return new Set(results.map((r) => (r.kind === 'print' ? r.value : r.value.slice(prefix.length))));
};

/** Every block row, for copying a stage's blocks into another (`bun run removals`). */
export interface BlockRow extends Block {
	readonly print_id: string;
	readonly report_id: string | null;
	readonly created_at: number;
}

export const loadBlocks = async (db: D1Database): Promise<BlockRow[]> =>
	(await db.prepare('SELECT kind, value, print_id, report_id, created_at FROM removal_blocks ORDER BY kind, value').all<BlockRow>())
		.results;

export const insertBlocks = (db: D1Database, rows: readonly BlockRow[]) =>
	rows.map((r) =>
		db
			.prepare('INSERT OR IGNORE INTO removal_blocks (kind, value, print_id, report_id, created_at) VALUES (?, ?, ?, ?, ?)')
			.bind(r.kind, r.value, r.print_id, r.report_id, r.created_at)
	);
