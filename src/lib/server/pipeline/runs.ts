/**
 * `pipeline_runs` (migration 0007): the contract between the runner, which writes a run's row
 * every few seconds, and /admin/pipeline, which reads it and sets `control`.
 */

export type RunKind = 'backfill' | 'sync' | 'reanalyze';
export type RunState = 'starting' | 'running' | 'paused' | 'stopping' | 'finished' | 'stopped' | 'failed';
export type RunControl = 'pause' | 'resume' | 'stop';

/** A run whose heartbeat is older than this while it claims to be live has crashed or lost its connection. */
export const HEARTBEAT_STALE_MS = 60_000;
/** How often the runner writes its row and reads `control`. */
export const HEARTBEAT_MS = 5_000;

export interface RunOptions {
	limit?: number;
	ids?: string[];
	concurrency: number;
	force: boolean;
	retryFailed: boolean;
	/** Compute workers and the per-print timeout (backfill). */
	workers?: number;
	timeoutMs?: number;
	/** Prints in the source (the whole mirror), and their total bytes, for projecting a sample run to a full one. */
	corpus?: number;
	corpusBytes?: number;
}

/** One `pipeline_runs` row, as stored (JSON columns still strings). */
export interface PipelineRunRow {
	id: string;
	kind: RunKind;
	stage: string;
	host: string;
	source: string;
	options: string;
	state: RunState;
	control: RunControl | null;
	total: number;
	done: number;
	analysed: number;
	viewer: number;
	/** D1 rows rewritten for a new INDEX_VERSION (migration 0009; `parseRun` reads it as 0 from older databases). */
	reindexed: number;
	unchanged: number;
	favorites: number;
	failed: number;
	skipped_failed: number;
	failures: string;
	rows_written: number;
	r2_objects: number;
	r2_bytes: number;
	/** Mirror bytes of the records behind those writes (migration 0008). */
	source_bytes: number;
	rate: number | null;
	eta_seconds: number | null;
	started_at: number;
	updated_at: number;
	finished_at: number | null;
	error: string | null;
}

export interface PipelineRun extends Omit<PipelineRunRow, 'options' | 'failures'> {
	options: RunOptions;
	failures: Record<string, number>;
}

export const parseRun = (row: PipelineRunRow): PipelineRun => ({
	...row,
	// Missing in databases from before migration 0009.
	reindexed: row.reindexed ?? 0,
	options: JSON.parse(row.options) as RunOptions,
	failures: JSON.parse(row.failures) as Record<string, number>
});

/** States of a run that hasn't ended (or claims not to: see `isStale`). Render runs (`render_runs`) use the same states. */
export const LIVE_STATES: readonly RunState[] = ['starting', 'running', 'paused', 'stopping'];

/** States in which a runner accepts each control (pipeline and render runs alike). */
export const CONTROL_STATES: Record<RunControl, readonly RunState[]> = {
	pause: ['starting', 'running'],
	resume: ['paused'],
	stop: ['starting', 'running', 'paused']
};

/** True when the run claims to be live but its heartbeat has stopped. */
export const isStale = (run: Pick<PipelineRun, 'state' | 'updated_at'>, now = Date.now()) =>
	LIVE_STATES.includes(run.state) && now - run.updated_at > HEARTBEAT_STALE_MS;

export const isLive = (run: Pick<PipelineRun, 'state' | 'updated_at'>, now = Date.now()) =>
	LIVE_STATES.includes(run.state) && !isStale(run, now);

/** The `failures` key for a failure reason: its first word ("decode: zlib" → "decode", "analyze v6: …" → "analyze"). */
export const failureBucket = (reason: string) => /^[a-z]+/i.exec(reason)?.[0].toLowerCase() ?? 'other';

/** `<ISO time to the second>-<4 random chars>`, e.g. `2026-10-19T07:05:12Z-k3f9`: sorts by start, unique enough. */
export const newRunId = (now = new Date()) =>
	`${now.toISOString().replace(/\.\d{3}Z$/, 'Z')}-${Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')}`;

/** Columns the runner owns: everything but `control`. */
const RUNNER_COLUMNS = [
	'id',
	'kind',
	'stage',
	'host',
	'source',
	'options',
	'state',
	'total',
	'done',
	'analysed',
	'viewer',
	'reindexed',
	'unchanged',
	'favorites',
	'failed',
	'skipped_failed',
	'failures',
	'rows_written',
	'r2_objects',
	'r2_bytes',
	'source_bytes',
	'rate',
	'eta_seconds',
	'started_at',
	'updated_at',
	'finished_at',
	'error'
] as const satisfies readonly (keyof PipelineRunRow)[];
/** Never rewritten by a heartbeat. */
const FIXED = new Set<string>(['id', 'kind', 'stage', 'host', 'source', 'options', 'started_at']);

/**
 * The runner's heartbeat: upsert its row (every column but `control`) and return the pending
 * `control`, if any, in one statement (one row written).
 */
export const writeRun = async (db: D1Database, row: Omit<PipelineRunRow, 'control'>): Promise<RunControl | null> => {
	const updates = RUNNER_COLUMNS.filter((c) => !FIXED.has(c)).map((c) => `${c} = excluded.${c}`);
	const result = await db
		.prepare(
			`INSERT INTO pipeline_runs (${RUNNER_COLUMNS.join(', ')}) VALUES (${RUNNER_COLUMNS.map(() => '?').join(', ')})
			ON CONFLICT (id) DO UPDATE SET ${updates.join(', ')} RETURNING control`
		)
		.bind(...RUNNER_COLUMNS.map((c) => row[c]))
		.first<{ control: RunControl | null }>();
	return result?.control ?? null;
};

/** Clear a `control` the runner has acted on, unless the admin page has since asked for something else. */
export const clearControl = async (db: D1Database, id: string, control: RunControl) => {
	await db.prepare('UPDATE pipeline_runs SET control = NULL WHERE id = ? AND control = ?').bind(id, control).run();
};

/** The newest runs, newest first. */
export const latestRuns = async (db: D1Database, n = 1): Promise<PipelineRun[]> => {
	const { results } = await db.prepare('SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT ?').bind(n).all<PipelineRunRow>();
	return results.map(parseRun);
};
