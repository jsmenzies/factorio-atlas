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
import { bumpPageVersion } from '../page-cache.js';
import { addToken, hasToken, removeToken } from './facet-token.js';
import { RENDER_TOKEN } from './repository.js';

const HAS_TOKEN = hasToken(RENDER_TOKEN);

export interface FtsFlag {
	rowid: number;
	print_id: string;
	flagged: number;
}

/** A search card's render thumbnail (migration 0018): the cover page, its overview's stamp and size. */
export interface RenderCover {
	page: string;
	stamp: string;
	w: number;
	h: number;
}

export interface RenderFlagState {
	/** print_renders: print id → pages. */
	rows: Map<string, number>;
	/** print_renders' cover columns, when the sync manages them: print id → cover (absent: none). */
	covers?: Map<string, RenderCover>;
	/** Every FTS row, with whether it carries the token. */
	fts: FtsFlag[];
}

export interface RenderFlagPlan {
	/** print_renders rows to insert or update: [print id, pages]. */
	upsert: [string, number][];
	/** Rows whose cover columns to set (null: clear), when covers are managed. */
	cover: [string, RenderCover | null][];
	/** print_renders rows to delete. */
	remove: string[];
	/** FTS rowids that need the token, and rowids that must lose it. */
	tag: number[];
	untag: number[];
}

const sameCover = (a: RenderCover | undefined | null, b: RenderCover | undefined | null) =>
	(a ?? null) === (b ?? null) || (!!a && !!b && a.page === b.page && a.stamp === b.stamp && a.w === b.w && a.h === b.h);

/**
 * The writes that bring `state` to `wanted` (print id → pages listed in its index, ≥ 1), and, when
 * `covers` is given, each flagged print's cover columns to `covers` (absent: none). Pure.
 */
export function planRenderFlags(wanted: Map<string, number>, state: RenderFlagState, covers?: Map<string, RenderCover>): RenderFlagPlan {
	const has = (id: string) => (wanted.get(id) ?? 0) > 0;
	const byId = (a: [string, unknown], b: [string, unknown]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
	return {
		upsert: [...wanted].filter(([id, pages]) => pages > 0 && state.rows.get(id) !== pages).sort(byId),
		cover: covers
			? [...wanted]
					.filter(([id, pages]) => pages > 0 && !sameCover(covers.get(id), state.covers?.get(id)))
					.map(([id]): [string, RenderCover | null] => [id, covers.get(id) ?? null])
					.sort(byId)
			: [],
		remove: [...state.rows.keys()].filter((id) => !has(id)).sort(),
		tag: state.fts.filter((f) => !f.flagged && has(f.print_id)).map((f) => f.rowid),
		untag: state.fts.filter((f) => !!f.flagged && !has(f.print_id)).map((f) => f.rowid)
	};
}

export const planSize = (p: RenderFlagPlan) => p.upsert.length + p.cover.length + p.remove.length + p.tag.length + p.untag.length;

/**
 * print_renders and the token on every FTS row, in pages (by primary key and by rowid, so no read
 * sorts the table); with `covers`, also the cover columns (migration 0018).
 */
export async function loadRenderFlagState(db: D1Database, pageSize = 5000, covers = false): Promise<RenderFlagState> {
	const rows = new Map<string, number>();
	const coverMap = new Map<string, RenderCover>();
	type Row = {
		print_id: string;
		pages: number;
		cover_page?: string | null;
		cover_stamp?: string | null;
		cover_w?: number | null;
		cover_h?: number | null;
	};
	const cols = covers ? 'print_id, pages, cover_page, cover_stamp, cover_w, cover_h' : 'print_id, pages';
	for (let after = ''; ;) {
		const { results } = await db
			.prepare(`SELECT ${cols} FROM print_renders WHERE print_id > ? ORDER BY print_id LIMIT ?`)
			.bind(after, pageSize)
			.all<Row>();
		for (const r of results) {
			rows.set(r.print_id, r.pages);
			if (r.cover_page != null && r.cover_stamp && r.cover_w && r.cover_h)
				coverMap.set(r.print_id, { page: r.cover_page, stamp: r.cover_stamp, w: r.cover_w, h: r.cover_h });
		}
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
	return covers ? { rows, covers: coverMap, fts } : { rows, fts };
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
		// After the upserts, so a newly flagged print's row exists.
		...plan.cover.map(([id, c]) =>
			db
				.prepare('UPDATE print_renders SET cover_page = ?, cover_stamp = ?, cover_w = ?, cover_h = ?, updated_at = ? WHERE print_id = ?')
				.bind(c?.page ?? null, c?.stamp ?? null, c?.w ?? null, c?.h ?? null, now, id)
		),
		...chunks(plan.remove, 99).map((c) => db.prepare(`DELETE FROM print_renders WHERE print_id IN (${marks(c.length)})`).bind(...c)),
		// The token goes first, so facetText's cap never cuts it. The guards keep a repeat harmless.
		...chunks(plan.tag, 99).map((c) =>
			db.prepare(`UPDATE print_search SET ${addToken(RENDER_TOKEN)} WHERE rowid IN (${marks(c.length)}) AND NOT ${HAS_TOKEN}`).bind(...c)
		),
		...chunks(plan.untag, 99).map((c) =>
			db
				.prepare(
					`UPDATE print_search SET ${removeToken(RENDER_TOKEN)}
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
	options: {
		dryRun?: boolean;
		batchSize?: number;
		now?: number;
		onBatch?: (done: number, total: number) => void;
		/** Each flagged print's search-card thumbnail (absent: none); without it the cover columns are left alone. */
		covers?: Map<string, RenderCover>;
	} = {}
): Promise<RenderFlagResult> {
	const state = await loadRenderFlagState(db, 5000, !!options.covers);
	const plan = planRenderFlags(wanted, state, options.covers);
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
		// Cards show render badges (and may show the cover thumbnail), so cached pages go (lib/server/page-cache.ts).
		if (rowsWritten > 0) await bumpPageVersion(db).run();
	}
	return { plan, flagged, searchable, rowsWritten };
}
