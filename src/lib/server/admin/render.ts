/**
 * Reads and controls the offline render queue for /admin/render: `render_runs` and `render_jobs`
 * (migration 0010), which `bun run render` fills in the local database as it runs. The runner owns
 * every column except `render_runs.control`, which only this module sets.
 */
import { LIVE_STATES } from '#lib/server/pipeline/runs.js';
import { JOB_STATUSES, RENDER_STALE_MS, type JobStatus, type RenderJobRow, type RenderRunRow } from '#lib/server/render-queue.js';
import { intParam, runControlActions } from './pipeline.js';
import { parseScopes, scopeStatements } from './render-scope.js';

/** Run options as the renderer records them; every field optional, since older runs may lack some. */
export interface RenderRunOptions {
	assets?: unknown;
	quality?: number;
	effort?: number;
	levels?: number[];
	workers?: number;
	limit?: number;
	ids?: string[];
	idsCount?: number | null;
	force?: boolean;
	forcePending?: boolean;
	/** A batch (`--next N`): its N, and the prints it picked. */
	next?: number | null;
	batch?: { next: number; picked: string[]; complete: boolean; candidates?: number; unseen?: number; left?: number } | null;
	/** Set on a run that resumes a batch. */
	batchOf?: number | null;
	/** `--top N`: the top-N favourites first in the selection, and the stored list it used. */
	top?: number | null;
	topList?: { n: number; source: string; refreshed_at: number; refreshed: boolean; added: number } | null;
	upload?: string | null;
	resumedFrom?: string | null;
	[key: string]: unknown;
}

export interface RenderRun extends Omit<RenderRunRow, 'options'> {
	options: RenderRunOptions;
}

const parseOptions = (json: string): RenderRunOptions => {
	try {
		const v = JSON.parse(json) as unknown;
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as RenderRunOptions) : {};
	} catch {
		return {};
	}
};

export const parseRenderRun = (row: RenderRunRow): RenderRun => ({ ...row, options: parseOptions(row.options) });

const isFresh = (run: Pick<RenderRun, 'state' | 'updated_at'>, now: number) =>
	LIVE_STATES.includes(run.state) && now - run.updated_at <= RENDER_STALE_MS;

/**
 * Reads gathered into one `db.batch`: one call, one transaction, so one chance (not ten) to meet a
 * render run's write lock on the local database. `add` returns a getter for its part of the results.
 */
class Reads {
	readonly #db: D1Database;
	readonly #stmts: D1PreparedStatement[] = [];
	#results: D1Result[] | null = null;
	constructor(db: D1Database) {
		this.#db = db;
	}
	add<T>(stmts: D1PreparedStatement[], parse: (results: D1Result[]) => T): () => T {
		const from = this.#stmts.length;
		this.#stmts.push(...stmts);
		return () => {
			if (!this.#results) throw new Error('Reads: run() first');
			return parse(this.#results.slice(from, from + stmts.length));
		};
	}
	async run() {
		this.#results = this.#stmts.length ? await this.#db.batch(this.#stmts) : [];
	}
}

const rows = <T>(r: D1Result | undefined) => (r?.results ?? []) as T[];
const count = (r: D1Result | undefined) => (r?.results[0] as { n: number } | undefined)?.n ?? 0;

/** The run to show first: the newest one whose heartbeat is fresh, else the newest one at all. */
const pickCurrent = (live: RenderRun[], latest: RenderRun | null, now: number) => live.find((r) => isFresh(r, now)) ?? latest;

const liveRunsStmt = (db: D1Database) =>
	db
		.prepare(`SELECT * FROM render_runs WHERE state IN (${LIVE_STATES.map(() => '?').join(', ')}) ORDER BY started_at DESC LIMIT 10`)
		.bind(...LIVE_STATES);
const latestRunStmt = (db: D1Database) => db.prepare(`SELECT * FROM render_runs ORDER BY started_at DESC LIMIT 1`);

const runStmt = (db: D1Database, id: string) => db.prepare(`SELECT * FROM render_runs WHERE id = ?`).bind(id);

export const RUNS_PAGE = 25;

/** Runs newest first; `before` (a started_at) pages back. One extra row tells whether there's more. */
const addRunHistory = (reads: Reads, db: D1Database, before?: number) =>
	reads.add(
		[
			db
				.prepare(`SELECT * FROM render_runs WHERE started_at < ? ORDER BY started_at DESC LIMIT ?`)
				.bind(before ?? Number.MAX_SAFE_INTEGER, RUNS_PAGE + 1)
		],
		([r]) => {
			const results = rows<RenderRunRow>(r);
			// The list shows no options, and a batch's (its picked ids) would make every poll many KB larger.
			const runs = results.slice(0, RUNS_PAGE).map((row) => parseRenderRun({ ...row, options: '{}' }));
			return { runs, older: results.length > RUNS_PAGE ? runs[runs.length - 1].started_at : null };
		}
	);

export interface QueueStatus {
	pages: number;
	files: number;
	bytes: number;
	entities: number;
	uploaded: number;
}

export interface QueueOverview {
	byStatus: Record<JobStatus, QueueStatus>;
	pages: number;
	prints: number;
	/** Prints with at least one rendered page. */
	printsDone: number;
	/** Pages whose files are in each bucket (render_uploads), by target. */
	uploads: { target: string; pages: number; current: number }[];
}

const emptyStatus = (): QueueStatus => ({ pages: 0, files: 0, bytes: 0, entities: 0, uploaded: 0 });

/** Pages by status across the whole queue (or one run's rows), with what the rendered ones store. */
const addQueueOverview = (reads: Reads, db: D1Database, runId?: string) => {
	const where = runId ? 'WHERE run_id = ?' : '';
	const bind = runId ? [runId] : [];
	return reads.add(
		[
			db
				.prepare(
					`SELECT status, count(*) AS pages, coalesce(sum(files), 0) AS files, coalesce(sum(bytes), 0) AS bytes,
					coalesce(sum(entities), 0) AS entities, count(uploaded_at) AS uploaded
					FROM render_jobs ${where} GROUP BY status`
				)
				.bind(...bind),
			db.prepare(`SELECT count(DISTINCT print_id) AS n FROM render_jobs ${where}`).bind(...bind),
			db
				.prepare(`SELECT count(DISTINCT print_id) AS n FROM render_jobs WHERE status = 'done' ${runId ? 'AND run_id = ?' : ''}`)
				.bind(...bind),
			// Pages in each bucket, and how many of those are the current render.
			db
				.prepare(
					`SELECT u.target, count(*) AS pages, sum(j.status = 'done' AND j.stamp = u.stamp AND u.stale = 0) AS current
					FROM render_uploads u JOIN render_jobs j ON j.print_id = u.print_id AND j.path = u.path
					WHERE u.stamp IS NOT NULL ${runId ? 'AND j.run_id = ?' : ''} GROUP BY u.target ORDER BY u.target`
				)
				.bind(...bind)
		],
		([groups, prints, printsDone, uploads]): QueueOverview => {
			const byStatus = Object.fromEntries(JOB_STATUSES.map((s) => [s, emptyStatus()])) as Record<JobStatus, QueueStatus>;
			let pages = 0;
			for (const row of rows<QueueStatus & { status: JobStatus }>(groups)) {
				if (!(row.status in byStatus)) continue;
				const { status, ...rest } = row;
				byStatus[status] = rest;
				pages += rest.pages;
			}
			return {
				byStatus,
				pages,
				prints: count(prints),
				printsDone: count(printsDone),
				uploads: rows<{ target: string; pages: number; current: number | null }>(uploads).map((u) => ({ ...u, current: u.current ?? 0 }))
			};
		}
	);
};

/** The kind of a skip reason: 'modded: a, b' and 'modded: c' are both 'modded'. */
const REASON_KIND = `CASE WHEN instr(reason, ':') > 0 THEN substr(reason, 1, instr(reason, ':') - 1) ELSE coalesce(reason, 'no reason') END`;

/** Skip reasons by kind, biggest first. */
const addSkipReasons = (reads: Reads, db: D1Database, runId?: string) =>
	reads.add(
		[
			db
				.prepare(
					`SELECT ${REASON_KIND} AS reason, count(*) AS n FROM render_jobs WHERE status = 'skipped' ${runId ? 'AND run_id = ?' : ''}
					GROUP BY 1 ORDER BY n DESC, 1 LIMIT 12`
				)
				.bind(...(runId ? [runId] : []))
		],
		([r]) => rows<{ reason: string; n: number }>(r).map((x) => [x.reason, x.n] as [string, number])
	);

/**
 * Skip reasons of each run that may be the current one (live, or the newest), so the dashboard
 * needs no second call once it has picked it. By run, biggest first; the caller keeps 12.
 */
const addCandidateSkips = (reads: Reads, db: D1Database) =>
	reads.add(
		[
			db
				.prepare(
					`SELECT run_id, ${REASON_KIND} AS reason, count(*) AS n FROM render_jobs
					WHERE status = 'skipped' AND run_id IN (
						SELECT id FROM (SELECT id FROM render_runs WHERE state IN (${LIVE_STATES.map(() => '?').join(', ')}) ORDER BY started_at DESC LIMIT 10)
						UNION SELECT id FROM (SELECT id FROM render_runs ORDER BY started_at DESC LIMIT 1)
					)
					GROUP BY 1, 2 ORDER BY 1, n DESC, 2`
				)
				.bind(...LIVE_STATES)
		],
		([r]) => {
			const by = new Map<string, [string, number][]>();
			for (const x of rows<{ run_id: string; reason: string; n: number }>(r)) {
				const list = by.get(x.run_id) ?? [];
				if (list.length < 12) list.push([x.reason, x.n]);
				by.set(x.run_id, list);
			}
			return by;
		}
	);

/** A page as the job lists show it. */
export interface RenderJob extends Omit<RenderJobRow, 'input_key' | 'queued_at' | 'uploaded_at'> {
	/** Whether the print is in this site's database, so its print and render pages exist. */
	onSite: boolean;
}

export interface JobPage {
	items: RenderJob[];
	total: number;
	page: number;
	pages: number;
	perPage: number;
}

export const RENDERED_PAGE = 10;
export const JOBS_PAGE = 25;
export const IN_FLIGHT_MAX = 24;

/**
 * Pages in one status, most recently finished first (the `render_jobs_status` index), optionally
 * only those a run last touched. `rendering` rows are ordered by when they started.
 */
const addJobsByStatus = (reads: Reads, db: D1Database, status: JobStatus, page: number, perPage: number, runId?: string) => {
	const where = `j.status = ?${runId ? ' AND j.run_id = ?' : ''}`;
	const bind = runId ? [status, runId] : [status];
	const order = status === 'rendering' ? 'j.started_at DESC' : status === 'pending' ? 'j.queued_at' : 'j.finished_at DESC';
	return reads.add(
		[
			db.prepare(`SELECT count(*) AS n FROM render_jobs j WHERE ${where}`).bind(...bind),
			db
				.prepare(
					`SELECT j.print_id, j.path, j.title, j.label, j.game_version, j.entities, j.status, j.reason, j.attempts, j.run_id,
					j.files, j.bytes, j.ms, j.overview, j.stamp, j.started_at, j.finished_at, p.id IS NOT NULL AS onSite
					FROM render_jobs j LEFT JOIN prints p ON p.id = j.print_id
					WHERE ${where} ORDER BY ${order}, j.print_id, j.path LIMIT ? OFFSET ?`
				)
				.bind(...bind, perPage, (page - 1) * perPage)
		],
		([n, r]): JobPage => {
			const total = count(n);
			const items = rows<Omit<RenderJob, 'onSite'> & { onSite: number }>(r).map((x) => ({ ...x, onSite: x.onSite === 1 }));
			return { items, total, page, pages: Math.max(1, Math.ceil(total / perPage)), perPage };
		}
	);
};

/** Everything the dashboard lists, for the whole queue or one run; `url` holds each list's page number. */
const addQueueLists = (reads: Reads, db: D1Database, url: URL, runId?: string) => {
	const rendered = addJobsByStatus(reads, db, 'done', intParam(url, 'rendered', 1), RENDERED_PAGE, runId);
	const inFlight = addJobsByStatus(reads, db, 'rendering', 1, IN_FLIGHT_MAX, runId);
	const failed = addJobsByStatus(reads, db, 'failed', intParam(url, 'failed', 1), JOBS_PAGE, runId);
	const skipped = addJobsByStatus(reads, db, 'skipped', intParam(url, 'skipped', 1), JOBS_PAGE, runId);
	return () => ({ rendered: rendered(), inFlight: inFlight(), failed: failed(), skipped: skipped() });
};

/**
 * Everything /admin/render shows, in one call: the current run (newest live one, else the newest)
 * and its skip reasons, the run history, the whole queue and its lists, and what the renders
 * cover (2.0+ prints, the top-N favourites, both: render-scope.ts).
 */
export const renderDashboard = async (db: D1Database, url: URL, now = Date.now(), older?: number) => {
	const reads = new Reads(db);
	const runs = reads.add([liveRunsStmt(db), latestRunStmt(db)], ([live, latest]) => ({
		live: rows<RenderRunRow>(live).map(parseRenderRun),
		latest: rows<RenderRunRow>(latest).map(parseRenderRun)[0] ?? null
	}));
	const skips = addCandidateSkips(reads, db);
	const history = addRunHistory(reads, db, older);
	const queue = addQueueOverview(reads, db);
	const lists = addQueueLists(reads, db, url);
	const scopes = reads.add(scopeStatements(db), parseScopes);
	await reads.run();
	const { live, latest } = runs();
	const run = pickCurrent(live, latest, now);
	return { run, runSkips: run ? (skips().get(run.id) ?? []) : [], history: history(), queue: queue(), ...lists(), scopes: scopes() };
};

/** Everything /admin/render/[runId] shows, in one call; null when there is no such run. */
export const renderRunPage = async (db: D1Database, id: string, url: URL) => {
	const reads = new Reads(db);
	const run = reads.add([runStmt(db, id)], ([r]) => rows<RenderRunRow>(r).map(parseRenderRun)[0] ?? null);
	const skips = addSkipReasons(reads, db, id);
	const queue = addQueueOverview(reads, db, id);
	const lists = addQueueLists(reads, db, url, id);
	await reads.run();
	const found = run();
	return found ? { run: found, runSkips: skips(), queue: queue(), ...lists() } : null;
};

/** Form actions shared by /admin/render and /admin/render/[runId]. */
export const renderControlActions = runControlActions('render_runs', { busy: true });
