/**
 * `render_runs` and `render_jobs` (migrations/0010_render_queue.sql), `render_uploads` and
 * `render_prints` (0011), `render_deletes` (0012), prints and upload-speed columns (0013) in the local D1, through
 * wrangler's platform proxy: the same database `vite dev` serves /admin/render from. Only the
 * runner's parent process writes here.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { LIVE_STATES, type RunControl } from '#lib/server/pipeline/runs.js';
import { RENDER_STALE_MS, type JobStatus, type RenderJobRow, type RenderRunRow } from '#lib/server/render-queue.js';
import type { DueDelete, UploadRow } from './upload.js';

/** Attempts a page gets at one input key before it's left failed. */
export const MAX_ATTEMPTS = 3;

/**
 * The row failed every attempt at input key `key`: it stays failed (listed as such) and is neither
 * queued nor work for `--next` until the key changes (the page, assets, fpsr or settings), or a run
 * with `--force` or `--retry-failed`. Without `key`, at whatever key the row has.
 */
export const gaveUp = (row: Pick<RenderJobRow, 'status' | 'attempts'> & Partial<Pick<RenderJobRow, 'input_key'>>, key?: string): boolean =>
	row.status === 'failed' && row.attempts >= MAX_ATTEMPTS && (key === undefined || row.input_key === key);

/** Whether a process exists (one owned by another user counts). */
export const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM';
	}
};

/** The local database is shared with `vite dev` and other scripts: retry when SQLite is busy. */
export async function retrying<T>(what: string, f: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await f();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (attempt >= 8 || !/busy|locked|SQLITE_BUSY|network connection lost|internal error/i.test(msg)) throw new Error(`${what}: ${msg}`);
			await sleep(100 * 2 ** attempt);
		}
	}
}

/**
 * Run statements in D1 batches of 200 (each batch is one transaction; keep them a sensible size),
 * each retried while the database is busy. Every caller's statements are idempotent, so a batch
 * that is retried after it went through does no harm.
 */
export async function inBatches(db: D1Database, what: string, statements: D1PreparedStatement[]) {
	for (let i = 0; i < statements.length; i += 200) {
		const part = statements.slice(i, i + 200);
		await retrying(what, () => db.batch(part));
	}
}

const RUN_COLUMNS = [
	'id',
	'host',
	'source',
	'options',
	'state',
	'total',
	'done',
	'rendered',
	'unchanged',
	'skipped',
	'failed',
	'files',
	'bytes',
	'rate',
	'eta_seconds',
	'started_at',
	'updated_at',
	'finished_at',
	'error',
	'upload_target',
	'uploaded',
	'upload_files',
	'upload_bytes',
	'upload_deleted',
	'uploads_pending',
	'upload_failed',
	'upload_error',
	'upload_deletes_pending',
	'prints_total',
	'prints_done',
	'prints_rendered',
	'upload_rate_bytes',
	'upload_rate_files',
	'upload_rate_pages'
] as const satisfies readonly (keyof RenderRunRow)[];

const JOB_COLUMNS = [
	'print_id',
	'path',
	'title',
	'label',
	'game_version',
	'entities',
	'input_key',
	'status',
	'reason',
	'attempts',
	'run_id',
	'files',
	'bytes',
	'ms',
	'overview',
	'stamp',
	'queued_at',
	'started_at',
	'finished_at'
] as const satisfies readonly (keyof RenderJobRow)[];

const UPLOAD_COLUMNS = [
	'target',
	'print_id',
	'path',
	'stamp',
	'rendered_at',
	'stale',
	'files',
	'bytes',
	'uploaded_at',
	'error',
	'failed_at'
] as const satisfies readonly (keyof UploadRow)[];

export type RunnerRun = Omit<RenderRunRow, 'control'>;
/** A row update that can wait for the next heartbeat; with `onlyIf`, applied only while the row has that status. */
export interface DeferredUpdate {
	printId: string;
	path: string;
	set: Partial<RenderJobRow>;
	onlyIf?: JobStatus;
}
export type JobWrite = Pick<RenderJobRow, (typeof JOB_COLUMNS)[number]>;

export function renderQueue(db: D1Database) {
	const upsertRun = `INSERT INTO render_runs (${RUN_COLUMNS.join(', ')}) VALUES (${RUN_COLUMNS.map(() => '?').join(', ')})
		ON CONFLICT (id) DO UPDATE SET ${RUN_COLUMNS.filter((c) => c !== 'id')
			.map((c) => `${c} = excluded.${c}`)
			.join(', ')}`;
	const upsertJob = `INSERT INTO render_jobs (${JOB_COLUMNS.join(', ')}) VALUES (${JOB_COLUMNS.map(() => '?').join(', ')})
		ON CONFLICT (print_id, path) DO UPDATE SET ${JOB_COLUMNS.filter((c) => c !== 'print_id' && c !== 'path')
			.map((c) => `${c} = excluded.${c}`)
			.join(', ')}`;
	const updateStatement = (printId: string, path: string, set: Partial<RenderJobRow>, onlyIf?: JobStatus) => {
		const cols = Object.keys(set) as (keyof RenderJobRow)[];
		return db
			.prepare(
				`UPDATE render_jobs SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE print_id = ? AND path = ?${onlyIf ? ' AND status = ?' : ''}`
			)
			.bind(...cols.map((c) => set[c] ?? null), printId, path, ...(onlyIf ? [onlyIf] : []));
	};

	return {
		/**
		 * Live runs other than `except`: a fresh heartbeat, and on this host a runner process
		 * (`options.pid`) that still exists, so a killed run doesn't block the next for 30 s.
		 */
		liveRuns: (except: string, host: string, now = Date.now()) =>
			retrying('live runs', async () =>
				(
					await db
						.prepare(
							`SELECT id, host, options, updated_at FROM render_runs WHERE state IN (${LIVE_STATES.map(() => '?').join(', ')}) AND id != ?`
						)
						.bind(...LIVE_STATES, except)
						.all<Pick<RenderRunRow, 'id' | 'host' | 'options' | 'updated_at'>>()
				).results.filter((r) => {
					if (now - r.updated_at >= RENDER_STALE_MS) return false;
					if (r.host !== host) return true;
					const pid = (JSON.parse(r.options) as { pid?: number }).pid;
					return pid === undefined || alive(pid);
				})
			),

		/** Runs on this host left in a live state whose runner process is gone (killed): their options say what they left running. */
		deadRuns: (except: string, host: string) =>
			retrying('dead runs', async () =>
				(
					await db
						.prepare(
							`SELECT id, options FROM render_runs WHERE state IN (${LIVE_STATES.map(() => '?').join(', ')}) AND id != ? AND host = ?`
						)
						.bind(...LIVE_STATES, except, host)
						.all<Pick<RenderRunRow, 'id' | 'options'>>()
				).results.filter((r) => {
					const pid = (JSON.parse(r.options) as { pid?: number }).pid;
					return pid !== undefined && !alive(pid);
				})
			),

		/**
		 * The heartbeat in one short transaction: the run row, row updates that could wait (pages
		 * marked rendering), then `control`. Fewer, shorter write locks on the database the dev server
		 * reads at the same time.
		 */
		beat: (run: RunnerRun, updates: DeferredUpdate[]) =>
			retrying('heartbeat', async () => {
				const results = await db.batch([
					db.prepare(upsertRun).bind(...RUN_COLUMNS.map((c) => run[c])),
					...updates.map((u) => updateStatement(u.printId, u.path, u.set, u.onlyIf)),
					db.prepare('SELECT control FROM render_runs WHERE id = ?').bind(run.id)
				]);
				return ((results.at(-1)?.results[0] as { control: RunControl | null } | undefined)?.control ?? null) as RunControl | null;
			}),

		/**
		 * Set a row's columns, and read the print's done pages (for its index.json) and how many of
		 * its pages are still pending or rendering, in one transaction.
		 */
		finishJob: (printId: string, path: string, set: Partial<RenderJobRow>) =>
			retrying('finish job', async () => {
				const [, done, open] = await db.batch([
					updateStatement(printId, path, set),
					db.prepare("SELECT path, stamp, overview FROM render_jobs WHERE print_id = ? AND status = 'done'").bind(printId),
					db.prepare("SELECT COUNT(*) AS n FROM render_jobs WHERE print_id = ? AND status IN ('pending', 'rendering')").bind(printId)
				]);
				return {
					done: done.results as { path: string; stamp: string | null; overview: string | null }[],
					open: (open.results[0] as { n: number } | undefined)?.n ?? 0
				};
			}),

		/** Write the runner's columns; `control` is left alone (the admin page owns it). */
		writeRun: (run: RunnerRun) =>
			retrying('write run', () =>
				db
					.prepare(upsertRun)
					.bind(...RUN_COLUMNS.map((c) => run[c]))
					.run()
			),

		/** Clear `control` once acted on (unless the admin page has already set something else) and write the run, in one transaction. */
		clearControl: (run: RunnerRun, seen: RunControl) =>
			retrying('clear control', () =>
				db.batch([
					db.prepare('UPDATE render_runs SET control = NULL WHERE id = ? AND control = ?').bind(run.id, seen),
					db.prepare(upsertRun).bind(...RUN_COLUMNS.map((c) => run[c]))
				])
			),

		/** Rows other runs left in 'rendering' (killed mid-page) go back to 'pending'. */
		resetStuck: (runId: string) =>
			retrying('reset stuck', async () => {
				const r = await db
					.prepare(
						"UPDATE render_jobs SET status = 'pending', started_at = NULL WHERE status = 'rendering' AND (run_id IS NULL OR run_id != ?)"
					)
					.bind(runId)
					.run();
				return r.meta.changes ?? 0;
			}),

		/** Every print that has rows, so the runner looks up rows only for those. */
		printsWithRows: () =>
			retrying(
				'prints with rows',
				async () =>
					new Set(
						(await db.prepare('SELECT DISTINCT print_id FROM render_jobs').all<{ print_id: string }>()).results.map((r) => r.print_id)
					)
			),

		jobsOf: (printId: string) =>
			retrying(
				'jobs of print',
				async () => (await db.prepare('SELECT * FROM render_jobs WHERE print_id = ?').bind(printId).all<RenderJobRow>()).results
			),

		/** Pending or rendering rows of a print, any run: while there are some, its tiles may still be needed. */
		openJobs: (printId: string) =>
			retrying(
				'open jobs',
				async () =>
					(
						await db
							.prepare("SELECT COUNT(*) AS n FROM render_jobs WHERE print_id = ? AND status IN ('pending', 'rendering')")
							.bind(printId)
							.first<{ n: number }>()
					)?.n ?? 0
			),

		/** Upserts and deletes in one batch. */
		writeJobs: (jobs: JobWrite[], deletes: { print_id: string; path: string }[] = []) => {
			if (!jobs.length && !deletes.length) return Promise.resolve();
			const statements = [
				...jobs.map((j) => db.prepare(upsertJob).bind(...JOB_COLUMNS.map((c) => j[c]))),
				...deletes.map((d) => db.prepare('DELETE FROM render_jobs WHERE print_id = ? AND path = ?').bind(d.print_id, d.path))
			];
			return inBatches(db, 'write jobs', statements);
		},

		/** Set a few columns of one row. */
		updateJob: (printId: string, path: string, set: Partial<RenderJobRow>) =>
			retrying('update job', () => updateStatement(printId, path, set).run()),

		/** The newest run, for `--resume`. */
		latestRun: () =>
			retrying('latest run', () => db.prepare('SELECT * FROM render_runs ORDER BY started_at DESC LIMIT 1').first<RenderRunRow>()),

		/** What `--next` needs of every row to tell which prints have work left. */
		allJobs: () =>
			retrying(
				'all jobs',
				async () =>
					(
						await db
							.prepare('SELECT print_id, path, status, reason, attempts, stamp, finished_at FROM render_jobs')
							.all<Pick<RenderJobRow, 'print_id' | 'path' | 'status' | 'reason' | 'attempts' | 'stamp' | 'finished_at'>>()
					).results
			),

		/** Prints looked at before (render_prints), with their source stamp. */
		seenPrints: () =>
			retrying(
				'seen prints',
				async () =>
					new Map(
						(await db.prepare('SELECT print_id, stamp FROM render_prints').all<{ print_id: string; stamp: string | null }>()).results.map(
							(r) => [r.print_id, r.stamp]
						)
					)
			),

		markSeen: (rows: { print_id: string; stamp: string | null; modern: boolean; checked_at: number }[]) => {
			if (!rows.length) return Promise.resolve();
			const sql = `INSERT INTO render_prints (print_id, stamp, modern, checked_at) VALUES (?, ?, ?, ?)
				ON CONFLICT (print_id) DO UPDATE SET stamp = excluded.stamp, modern = excluded.modern, checked_at = excluded.checked_at`;
			const statements = rows.map((r) => db.prepare(sql).bind(r.print_id, r.stamp, r.modern ? 1 : 0, r.checked_at));
			return inBatches(db, 'mark seen', statements);
		},

		/** Every upload row of a target. */
		allUploads: (target: string) =>
			retrying(
				'all uploads',
				async () => (await db.prepare('SELECT * FROM render_uploads WHERE target = ?').bind(target).all<UploadRow>()).results
			),

		uploadsOf: (target: string, printId: string) =>
			retrying(
				'uploads of print',
				async () =>
					(await db.prepare('SELECT * FROM render_uploads WHERE target = ? AND print_id = ?').bind(target, printId).all<UploadRow>())
						.results
			),

		/** A page's files are up: its upload row, and for prod render_jobs.uploaded_at. */
		recordUpload: (row: UploadRow) => {
			const statements = [
				db
					.prepare(
						`INSERT INTO render_uploads (${UPLOAD_COLUMNS.join(', ')}) VALUES (${UPLOAD_COLUMNS.map(() => '?').join(', ')})
						ON CONFLICT (target, print_id, path) DO UPDATE SET ${UPLOAD_COLUMNS.slice(3)
							.map((c) => `${c} = excluded.${c}`)
							.join(', ')}`
					)
					.bind(...UPLOAD_COLUMNS.map((c) => row[c]))
			];
			if (row.target === 'prod') {
				statements.push(
					db
						.prepare('UPDATE render_jobs SET uploaded_at = ? WHERE print_id = ? AND path = ? AND stamp = ?')
						.bind(row.uploaded_at, row.print_id, row.path, row.stamp)
				);
			}
			return retrying('record upload', () => db.batch(statements));
		},

		/** A page's upload failed: the error on its row; what was uploaded before stays recorded. */
		recordFailure: (target: string, printId: string, path: string, error: string, at: number) =>
			retrying('record upload failure', () =>
				db
					.prepare(
						`INSERT INTO render_uploads (target, print_id, path, error, failed_at) VALUES (?, ?, ?, ?, ?)
						ON CONFLICT (target, print_id, path) DO UPDATE SET error = excluded.error, failed_at = excluded.failed_at`
					)
					.bind(target, printId, path, error.slice(0, 2000), at)
					.run()
			),

		forgetUploads: (target: string, printId: string, paths: string[]) =>
			retrying('forget uploads', () =>
				db.batch(
					paths.map((p) => db.prepare('DELETE FROM render_uploads WHERE target = ? AND print_id = ? AND path = ?').bind(target, printId, p))
				)
			),

		/** Bucket keys to delete once `notBefore` has passed. A key already waiting keeps its earlier time. */
		scheduleDeletes: (target: string, rows: { key: string; print_id: string; reason: string }[], notBefore: number, queuedAt: number) => {
			if (!rows.length) return Promise.resolve();
			const sql = `INSERT INTO render_deletes (target, key, print_id, not_before, reason, queued_at) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT (target, key) DO NOTHING`;
			const statements = rows.map((r) => db.prepare(sql).bind(target, r.key, r.print_id, notBefore, r.reason, queuedAt));
			return inBatches(db, 'schedule deletes', statements);
		},

		/** Keys of a print waiting to be deleted. */
		pendingDeletesOf: (target: string, printId: string) =>
			retrying('pending deletes of print', async () =>
				(
					await db.prepare('SELECT key FROM render_deletes WHERE target = ? AND print_id = ?').bind(target, printId).all<{ key: string }>()
				).results.map((r) => r.key)
			),

		/** Up to `limit` deletions due at `at`, in key order after `after` (so prints come together). */
		dueDeletes: (target: string, at: number, after: string, limit: number) =>
			retrying(
				'due deletes',
				async () =>
					(
						await db
							.prepare(
								'SELECT key, print_id, reason FROM render_deletes WHERE target = ? AND not_before <= ? AND key > ? ORDER BY key LIMIT ?'
							)
							.bind(target, at, after, limit)
							.all<DueDelete>()
					).results
			),

		/** Deleted, cancelled or no longer wanted: the rows go. */
		dropDeletes: (target: string, keys: string[]) => {
			if (!keys.length) return Promise.resolve();
			const statements = keys.map((k) => db.prepare('DELETE FROM render_deletes WHERE target = ? AND key = ?').bind(target, k));
			return inBatches(db, 'drop deletes', statements);
		},

		/** Deletions waiting for a target, and when the next is due (unix ms). */
		countDeletes: (target: string) =>
			retrying('count deletes', async () => {
				const r = await db
					.prepare('SELECT count(*) AS n, min(not_before) AS next FROM render_deletes WHERE target = ?')
					.bind(target)
					.first<{ n: number; next: number | null }>();
				return { n: r?.n ?? 0, next: r?.next ?? null };
			}),

		/** The page's files changed on disk under the same stamp (page data rewritten): every bucket needs them again. */
		markStale: (printId: string, path: string) =>
			retrying('mark stale', () =>
				db.prepare('UPDATE render_uploads SET stale = 1 WHERE print_id = ? AND path = ?').bind(printId, path).run()
			),

		/** Done pages of a print, for its index.json. */
		donePages: (printId: string) =>
			retrying(
				'done pages',
				async () =>
					(
						await db
							.prepare("SELECT path, stamp, overview FROM render_jobs WHERE print_id = ? AND status = 'done'")
							.bind(printId)
							.all<{ path: string; stamp: string | null; overview: string | null }>()
					).results
			)
	};
}

export type RenderQueue = ReturnType<typeof renderQueue>;
