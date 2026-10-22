/**
 * Which prints have a game render, in a stage's D1: `print_renders` (migration 0015) and the
 * `render_yes` token in each print's FTS `facets` column, which the search filter
 * "Only prints with a render" (`?render=1`) matches. `bun run render:flags` computes the wanted
 * set from what the render runs uploaded and calls `syncRenderFlags`; `upsert` (repository.ts)
 * adds the token to a re-ingested print whenever its print_renders row exists.
 *
 * Idempotent: the sync reads what the stage holds now (the table and the token on every FTS row)
 * and writes only the difference, so a second run writes nothing, and an FTS row that drifted
 * (e.g. written by an older build) is put right.
 */
import { RENDER_TOKEN } from './repository';

/** `' ' || facets || ' '` holds the token as a whole word. */
const HAS_TOKEN = `instr(' ' || facets || ' ', ' ${RENDER_TOKEN} ') > 0`;

export interface FtsFlag {
	rowid: number;
	print_id: string;
	flagged: number;
}

export interface RenderFlagState {
	/** print_renders: print id → pages. */
	rows: Map<string, number>;
	/** Every FTS row, with whether it carries the token. */
	fts: FtsFlag[];
}

export interface RenderFlagPlan {
	/** print_renders rows to insert or update: [print id, pages]. */
	upsert: [string, number][];
	/** print_renders rows to delete. */
	remove: string[];
	/** FTS rowids that need the token, and rowids that must lose it. */
	tag: number[];
	untag: number[];
}

/** The writes that bring `state` to `wanted` (print id → pages listed in its index, ≥ 1). Pure. */
export function planRenderFlags(wanted: Map<string, number>, state: RenderFlagState): RenderFlagPlan {
	const has = (id: string) => (wanted.get(id) ?? 0) > 0;
	return {
		upsert: [...wanted].filter(([id, pages]) => pages > 0 && state.rows.get(id) !== pages).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		remove: [...state.rows.keys()].filter((id) => !has(id)).sort(),
		tag: state.fts.filter((f) => !f.flagged && has(f.print_id)).map((f) => f.rowid),
		untag: state.fts.filter((f) => !!f.flagged && !has(f.print_id)).map((f) => f.rowid)
	};
}

export const planSize = (p: RenderFlagPlan) => p.upsert.length + p.remove.length + p.tag.length + p.untag.length;

/** print_renders and the token on every FTS row, in pages (by primary key and by rowid, so no read sorts the table). */
export async function loadRenderFlagState(db: D1Database, pageSize = 5000): Promise<RenderFlagState> {
	const rows = new Map<string, number>();
	for (let after = ''; ;) {
		const { results } = await db
			.prepare('SELECT print_id, pages FROM print_renders WHERE print_id > ? ORDER BY print_id LIMIT ?')
			.bind(after, pageSize)
			.all<{ print_id: string; pages: number }>();
		for (const r of results) rows.set(r.print_id, r.pages);
		if (results.length < pageSize) break;
		after = results[results.length - 1].print_id;
	}
	const fts: FtsFlag[] = [];
	for (let after = 0; ;) {
		const { results } = await db
			.prepare(`SELECT rowid, print_id, ${HAS_TOKEN} AS flagged FROM print_search WHERE rowid > ? ORDER BY rowid LIMIT ?`)
			.bind(after, pageSize)
			.all<FtsFlag>();
		fts.push(...results);
		if (results.length < pageSize) break;
		after = results[results.length - 1].rowid;
	}
	return { rows, fts };
}

/** Bound parameters per statement stay under D1's 100. */
const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const marks = (n: number) => Array(n).fill('?').join(', ');

/** The plan as D1 statements, each with at most 99 bound parameters. */
export function renderFlagStatements(db: D1Database, plan: RenderFlagPlan, now = Date.now()): D1PreparedStatement[] {
	return [
		...chunks(plan.upsert, 33).map((c) =>
			db
				.prepare(
					`INSERT INTO print_renders (print_id, pages, updated_at) VALUES ${c.map(() => '(?, ?, ?)').join(', ')}
					ON CONFLICT (print_id) DO UPDATE SET pages = excluded.pages, updated_at = excluded.updated_at`
				)
				.bind(...c.flatMap(([id, pages]) => [id, pages, now]))
		),
		...chunks(plan.remove, 99).map((c) => db.prepare(`DELETE FROM print_renders WHERE print_id IN (${marks(c.length)})`).bind(...c)),
		// The token goes first, so facetText's cap never cuts it. The guards keep a repeat harmless.
		...chunks(plan.tag, 99).map((c) =>
			db
				.prepare(`UPDATE print_search SET facets = '${RENDER_TOKEN} ' || facets WHERE rowid IN (${marks(c.length)}) AND NOT ${HAS_TOKEN}`)
				.bind(...c)
		),
		...chunks(plan.untag, 99).map((c) =>
			db
				.prepare(
					`UPDATE print_search SET facets = trim(replace(' ' || facets || ' ', ' ${RENDER_TOKEN} ', ' '))
					WHERE rowid IN (${marks(c.length)}) AND ${HAS_TOKEN}`
				)
				.bind(...c)
		)
	];
}

export interface RenderFlagResult {
	plan: RenderFlagPlan;
	/** Prints flagged once the sync is done (print_renders rows). */
	flagged: number;
	/** Of those, prints ingested in this stage (with an FTS row). */
	searchable: number;
	rowsWritten: number;
}

/**
 * Bring the stage's print_renders and FTS tokens in line with `wanted`, in D1 batches of
 * `batchSize` statements (each batch is one transaction). `dryRun` only plans.
 */
export async function syncRenderFlags(
	db: D1Database,
	wanted: Map<string, number>,
	options: { dryRun?: boolean; batchSize?: number; now?: number; onBatch?: (done: number, total: number) => void } = {}
): Promise<RenderFlagResult> {
	const state = await loadRenderFlagState(db);
	const plan = planRenderFlags(wanted, state);
	const flagged = [...wanted.values()].filter((n) => n > 0).length;
	const searchable = state.fts.filter((f) => (wanted.get(f.print_id) ?? 0) > 0).length;
	let rowsWritten = 0;
	if (!options.dryRun) {
		const stmts = renderFlagStatements(db, plan, options.now);
		const size = options.batchSize ?? 50;
		for (let i = 0; i < stmts.length; i += size) {
			const results = await db.batch(stmts.slice(i, i + size));
			rowsWritten += results.reduce((n, r) => n + (r.meta?.rows_written ?? 0), 0);
			options.onBatch?.(Math.min(i + size, stmts.length), stmts.length);
		}
	}
	return { plan, flagged, searchable, rowsWritten };
}
