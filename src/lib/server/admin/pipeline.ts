/**
 * Reads and controls `pipeline_runs` for /admin/pipeline (contract: #lib/server/pipeline/runs.ts).
 * The runner owns every column except `control`, which only this module sets.
 */
import { fail, type Action, type Cookies, type ServerLoadEvent } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { validTimeZone } from '#lib/components/admin/metrics.js';
import { BUSY_RESULT, orBusy } from './busy.js';
import {
	CONTROL_STATES,
	HEARTBEAT_MS,
	HEARTBEAT_STALE_MS,
	isLive,
	isStale,
	LIVE_STATES,
	parseRun,
	type PipelineRun,
	type PipelineRunRow,
	type RunControl
} from '#lib/server/pipeline/runs.js';

/** The run to show first: the newest one whose heartbeat is fresh, else the newest one at all. */
export const currentRun = async (db: D1Database, now = Date.now()): Promise<PipelineRun | null> => {
	const live = await db
		.prepare(`SELECT * FROM pipeline_runs WHERE state IN (${LIVE_STATES.map(() => '?').join(', ')}) ORDER BY started_at DESC LIMIT 10`)
		.bind(...LIVE_STATES)
		.all<PipelineRunRow>();
	const fresh = live.results.map(parseRun).find((r) => isLive(r, now));
	if (fresh) return fresh;
	const latest = await db.prepare(`SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT 1`).first<PipelineRunRow>();
	return latest ? parseRun(latest) : null;
};

export const getRun = async (db: D1Database, id: string): Promise<PipelineRun | null> => {
	const row = await db.prepare(`SELECT * FROM pipeline_runs WHERE id = ?`).bind(id).first<PipelineRunRow>();
	return row ? parseRun(row) : null;
};

export const HISTORY_PAGE = 25;

/** Runs newest first; `before` (a started_at) pages back. One extra row tells whether there's more. */
export const listRuns = async (db: D1Database, before?: number) => {
	const { results } = await db
		.prepare(`SELECT * FROM pipeline_runs WHERE started_at < ? ORDER BY started_at DESC LIMIT ?`)
		.bind(before ?? Number.MAX_SAFE_INTEGER, HISTORY_PAGE + 1)
		.all<PipelineRunRow>();
	const runs = results.slice(0, HISTORY_PAGE).map(parseRun);
	return { runs, older: results.length > HISTORY_PAGE ? runs[runs.length - 1].started_at : null };
};

export const FAILED_PAGE = 25;

export interface FailedPrint {
	id: string;
	reason: string | null;
	checkedAt: number;
	/** Whether the print has a page on this site (an earlier version that did ingest). */
	onSite: boolean;
}

/**
 * Prints recorded as failed during the run: ingest_state rows with status 'failed' checked between
 * the run's start and its end (now while live, the last heartbeat if it crashed). A print that failed in this run and was retried by a later
 * one shows under the later run only, since checked_at moves.
 */
export const failedPrints = async (db: D1Database, run: PipelineRun, page: number, now = Date.now()) => {
	// A crashed run (stale heartbeat) did nothing after its last heartbeat.
	const to = run.finished_at ?? (isStale(run, now) ? run.updated_at + HEARTBEAT_MS : Math.max(now, run.updated_at));
	const where = `s.status = 'failed' AND s.checked_at BETWEEN ? AND ?`;
	const [count, rows] = await db.batch([
		db.prepare(`SELECT count(*) AS n FROM ingest_state s WHERE ${where}`).bind(run.started_at, to),
		db
			.prepare(
				`SELECT s.print_id AS id, s.reason, s.checked_at AS checkedAt, p.id IS NOT NULL AS onSite
				FROM ingest_state s LEFT JOIN prints p ON p.id = s.print_id
				WHERE ${where} ORDER BY s.checked_at DESC, s.print_id LIMIT ? OFFSET ?`
			)
			.bind(run.started_at, to, FAILED_PAGE, (page - 1) * FAILED_PAGE)
	]);
	const total = (count.results[0] as { n: number } | undefined)?.n ?? 0;
	const items = (rows.results as (Omit<FailedPrint, 'onSite'> & { onSite: number })[]).map((r) => ({ ...r, onSite: r.onSite === 1 }));
	return { items, total, page, pages: Math.max(1, Math.ceil(total / FAILED_PAGE)), perPage: FAILED_PAGE };
};

/**
 * Asks a backfill (`pipeline_runs`) or render run (`render_runs`) to pause, resume or stop at its
 * next heartbeat. Only `control` is written, never `updated_at` (that's the heartbeat). A later
 * request replaces a pending one; null withdraws it.
 */
export const setControl = async (db: D1Database, table: 'pipeline_runs' | 'render_runs', id: string, control: RunControl | null) => {
	const states = control ? CONTROL_STATES[control] : LIVE_STATES;
	const result = await db
		.prepare(`UPDATE ${table} SET control = ? WHERE id = ? AND state IN (${states.map(() => '?').join(', ')})`)
		.bind(control, id, ...states)
		.run();
	return result.meta.changes > 0;
};

/**
 * Pause, resume, stop and cancel (withdraw) form actions for one kind of run. `busy`: the table is
 * in the local database a run writes to, so retry its lock (busy.ts) and answer 503 if it holds.
 */
export const runControlActions = (table: 'pipeline_runs' | 'render_runs', { busy = false } = {}) => {
	const control =
		(value: RunControl | null): Action =>
		async ({ request }) => {
			const id = (await request.formData()).get('id');
			if (typeof id !== 'string' || !id) return fail(400, { message: 'Missing run id.' });
			const set = () => setControl(env.DB, table, id, value);
			const changed = busy ? await orBusy(set) : await set();
			if (changed === BUSY_RESULT)
				return fail(503, { message: 'The local database is busy (a run is writing to it); try again in a moment.' });
			if (!changed) {
				return fail(409, { message: value ? `This run can't ${value} in its current state.` : 'This run has finished.' });
			}
			return { ok: true };
		};
	return { pause: control('pause'), resume: control('resume'), stop: control('stop'), cancel: control(null) };
};

/** Form actions shared by /admin/pipeline and /admin/pipeline/[runId]. */
export const controlActions = runControlActions('pipeline_runs');

/** `?name=` as a positive integer, else the fallback. */
export const intParam = (url: URL, name: string, fallback: number) => {
	const n = Number(url.searchParams.get(name));
	return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

/** The viewer's time zone from the `tz` cookie the page sets, else UTC (what Workers run in). */
export const viewerTimeZone = (cookies: Cookies) => validTimeZone(cookies.get('tz')) ?? 'UTC';

/**
 * What every admin run page loads besides its own data: it registers the `admin:pipeline` key that
 * the pages' poll() and syncTimeZone() invalidate, and gives the live view the server's clock, the
 * viewer's time zone and the run table's heartbeat timings.
 */
export const liveBase = (
	{ depends, cookies }: Pick<ServerLoadEvent, 'depends' | 'cookies'>,
	timing: { staleMs: number; heartbeatMs: number }
) => {
	depends('admin:pipeline');
	return { serverNow: Date.now(), timeZone: viewerTimeZone(cookies), ...timing };
};

/** The backfill's heartbeat timings, for liveBase. */
export const PIPELINE_TIMING = { staleMs: HEARTBEAT_STALE_MS, heartbeatMs: HEARTBEAT_MS };
