/**
 * The state of each print's screenshot copy, in a stage's D1: the `screenshots` table (migration
 * 0019), which search cards join by primary key. 'copied' rows carry what names our files; 'dead'
 * and 'removed' rows tell cards not to fall back to Imgur; no row means not copied yet (cards still
 * show Imgur's copy). `bun run screenshots:flags` computes the wanted rows from what the uploads put
 * in the stage's bucket and calls `syncScreenshotFlags`, which forces every image in
 * `screenshot_removals` to 'removed', writes only the difference, then purges the page cache.
 * `bun run screenshots:remove` writes one removal at once (`removalStatements`).
 */
import { bumpPageVersion } from './page-cache';

export type ShotRow = { state: 'copied'; v: number; ext: string; w: number; h: number } | { state: 'dead' | 'removed' };

export interface ShotFlagPlan {
	/** Rows to insert or update. */
	upsert: [string, ShotRow][];
	/** Rows to delete (the image is in no bucket manifest and wasn't taken down). */
	remove: string[];
}

const same = (a: ShotRow | undefined, b: ShotRow) => !!a && JSON.stringify(a) === JSON.stringify(b);

/** `wanted` with every image taken down on request forced to 'removed' (whether or not it was ever uploaded). */
export const withRemovals = (wanted: Map<string, ShotRow>, removed: ReadonlySet<string>) => {
	const out = new Map(wanted);
	for (const id of removed) out.set(id, { state: 'removed' });
	return out;
};

/** The writes that bring `rows` (the table now) to `wanted` with the removals applied. Pure. */
export function planShotFlags(wanted: Map<string, ShotRow>, rows: Map<string, ShotRow>, removed: ReadonlySet<string>): ShotFlagPlan {
	const want = withRemovals(wanted, removed);
	return {
		upsert: [...want].filter(([id, r]) => !same(rows.get(id), r)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		remove: [...rows.keys()].filter((id) => !want.has(id)).sort()
	};
}

export const shotPlanSize = (p: ShotFlagPlan) => p.upsert.length + p.remove.length;

const rowOf = (r: { state: string; v: number | null; ext: string | null; w: number | null; h: number | null }): ShotRow =>
	r.state === 'copied' ? { state: 'copied', v: r.v!, ext: r.ext!, w: r.w!, h: r.h! } : { state: r.state as 'dead' | 'removed' };

/** The table and the removals, in pages by primary key. */
export async function loadShotFlagState(db: D1Database, pageSize = 5000) {
	const rows = new Map<string, ShotRow>();
	type Row = { image_id: string; state: string; v: number | null; ext: string | null; w: number | null; h: number | null };
	for (let after = ''; ;) {
		const { results } = await db
			.prepare('SELECT image_id, state, v, ext, w, h FROM screenshots WHERE image_id > ? ORDER BY image_id LIMIT ?')
			.bind(after, pageSize)
			.all<Row>();
		for (const r of results) rows.set(r.image_id, rowOf(r));
		if (results.length < pageSize) break;
		after = results[results.length - 1].image_id;
	}
	const { results } = await db.prepare('SELECT image_id FROM screenshot_removals').all<{ image_id: string }>();
	return { rows, removed: new Set(results.map((r) => r.image_id)) };
}

const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

const UPSERT = `ON CONFLICT (image_id) DO UPDATE SET state = excluded.state, v = excluded.v, ext = excluded.ext, w = excluded.w, h = excluded.h,
	updated_at = excluded.updated_at`;
const values = (id: string, r: ShotRow, now: number) =>
	r.state === 'copied' ? [id, r.state, r.v, r.ext, r.w, r.h, now] : [id, r.state, null, null, null, null, now];

/** The plan as D1 statements, each with at most 98 bound parameters. */
export function shotFlagStatements(db: D1Database, plan: ShotFlagPlan, now = Date.now()): D1PreparedStatement[] {
	return [
		...chunks(plan.upsert, 14).map((c) =>
			db
				.prepare(
					`INSERT INTO screenshots (image_id, state, v, ext, w, h, updated_at) VALUES ${c.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')} ${UPSERT}`
				)
				.bind(...c.flatMap(([id, r]) => values(id, r, now)))
		),
		...chunks(plan.remove, 98).map((c) =>
			db.prepare(`DELETE FROM screenshots WHERE image_id IN (${c.map(() => '?').join(', ')})`).bind(...c)
		)
	];
}

/** An image's `screenshots` row set to 'removed' (inserted when it has none, so cards stop showing Imgur's copy). */
export const removedRowStatement = (db: D1Database, image: string, now = Date.now()) =>
	db
		.prepare(`INSERT INTO screenshots (image_id, state, v, ext, w, h, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ${UPSERT}`)
		.bind(...values(image, { state: 'removed' }, now));

/**
 * One removal on request, without the page-cache bump: the `screenshot_removals` record (so no later
 * fetch, upload or flags run brings it back) and a 'removed' row. A takedown runs these and bumps once
 * at its very end (takedown.ts).
 */
export const removalRecordStatements = (db: D1Database, image: string, print: string | null, reason: string | null, now = Date.now()) => [
	db
		.prepare(
			`INSERT INTO screenshot_removals (image_id, print_id, reason, removed_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (image_id) DO UPDATE SET reason = excluded.reason, removed_at = excluded.removed_at`
		)
		.bind(image, print, reason, now),
	removedRowStatement(db, image, now)
];

/** `removalRecordStatements`, then a new page-cache version (`bun run screenshots:remove`). */
export const removalStatements = (db: D1Database, image: string, print: string | null, reason: string | null, now = Date.now()) => [
	...removalRecordStatements(db, image, print, reason, now),
	bumpPageVersion(db, now)
];

/** Bring the stage's `screenshots` table in line with `wanted`, in batches; `dryRun` only plans. */
export async function syncScreenshotFlags(
	db: D1Database,
	wanted: Map<string, ShotRow>,
	options: { dryRun?: boolean; batchSize?: number; now?: number; onBatch?: (done: number, total: number) => void } = {}
) {
	const { rows, removed } = await loadShotFlagState(db);
	const plan = planShotFlags(wanted, rows, removed);
	let rowsWritten = 0;
	if (!options.dryRun) {
		const stmts = shotFlagStatements(db, plan, options.now);
		const size = options.batchSize ?? 50;
		for (let i = 0; i < stmts.length; i += size) {
			const results = await db.batch(stmts.slice(i, i + size));
			rowsWritten += results.reduce((n, r) => n + (r.meta?.rows_written ?? 0), 0);
			options.onBatch?.(Math.min(i + size, stmts.length), stmts.length);
		}
		// Cards change, so cached pages go (page-cache.ts).
		if (rowsWritten > 0) await bumpPageVersion(db).run();
	}
	return { plan, removed: removed.size, rows: rows.size, rowsWritten };
}
