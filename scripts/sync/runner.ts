/**
 * The update's runner (scripts/sync.ts builds the steps): its `sync_runs` row and heartbeat, the log,
 * stopping, running each step's command, and the order and gating of the steps.
 *
 * - The log is one file, `sync-<time>.log`. Step commands write to it directly (their stdout and
 *   stderr are its descriptor, not pipes), so a step outlives a runner that dies without breaking
 *   on a closed pipe; the runner reads each step's part back for its summary and echoes the file to
 *   the terminal as it grows.
 * - Steps run in their own process group. Each stop request (Ctrl-C, SIGTERM, SIGHUP, or `control`
 *   'stop' then 'quit' from the Overview) passes one SIGINT to the current step, which ends cleanly
 *   on the first and at once on the second; a step still running QUIT_GRACE_MS after the second has
 *   its group killed. No step starts after a stop.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, fstatSync, openSync, readFileSync, readSync, writeSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import { retryBusy } from '#lib/server/admin/busy.js';
import { OPEN_SYNC_PARAMS, OPEN_SYNC_WHERE, SYNC_RUN_ENV, writeSyncRun } from '#lib/server/sync.js';
import { LIVE_STATES } from '#lib/server/pipeline/runs.js';
import { RENDER_STALE_MS } from '#lib/server/render-queue.js';
import {
	parseSyncRun,
	stepLabel,
	SYNC_HEARTBEAT_MS,
	SYNC_STALE_MS,
	type SyncRun,
	type SyncRunRow,
	type SyncStep,
	type SyncStepId
} from '#lib/sync.js';
import { alive } from '../render/queue';
import type { PolledAdmitResult } from '../polled';

/** How long a step may take to end after Quit before its process group is killed. */
export const QUIT_GRACE_MS = 30_000;
/** The most of a step's output kept for its summary. */
const TAIL_BYTES = 40_000;

// --- starting

/** Whether `pid` is one of this repo's scripts still running (a pid alone may have been reused since). */
export const scriptAlive = (pid: unknown) => {
	if (typeof pid !== 'number' || !alive(pid)) return false;
	try {
		return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('scripts/');
	} catch {
		// No /proc (not Linux): the pid exists, which is the best we know.
		return true;
	}
};

/**
 * Before an update starts, in one write transaction so two starts can't both pass: close rows left
 * live by an update whose processes are gone (as failed), refuse while one is live, or its runner or
 * step still runs, or a render run is live; else write `run` as the new row. The refusal, or null.
 */
export function claimRun(
	sqlite: Database,
	run: SyncRun,
	now = Date.now(),
	isAlive: (pid: unknown) => boolean = scriptAlive
): string | null {
	return sqlite
		.transaction((): string | null => {
			for (const row of sqlite.query(`SELECT * FROM sync_runs WHERE ${OPEN_SYNC_WHERE}`).all(...OPEN_SYNC_PARAMS) as SyncRunRow[]) {
				if (now - row.updated_at <= SYNC_STALE_MS) return `an update is already running (${row.id})`;
				const old = parseSyncRun(row);
				const running = [old.options.pid, old.options.childPid].filter(isAlive);
				if (running.length)
					return `update ${row.id} stopped writing its row, but its processes are still running (pid ${running.join(', ')}): end them first`;
				for (const step of old.steps)
					if (step.status === 'running') Object.assign(step, { status: 'failed', summary: 'the update stopped responding' });
					else if (step.status === 'pending') step.status = 'stopped';
				sqlite
					.query("UPDATE sync_runs SET state = 'failed', steps = ?, finished_at = updated_at, error = ? WHERE id = ?")
					.run(JSON.stringify(old.steps), 'stopped responding (its process ended without finishing)', row.id);
			}
			const render = sqlite
				.query(`SELECT id FROM render_runs WHERE state IN (${LIVE_STATES.map(() => '?').join(', ')}) AND updated_at > ? LIMIT 1`)
				.get(...LIVE_STATES, now - RENDER_STALE_MS) as { id: string } | null;
			if (render) return `a render run is live (${render.id}): it reads the print sources, so stop it or let it finish first`;
			sqlite
				.query(
					`INSERT INTO sync_runs (id, state, stage, options, sources, steps, started_at, updated_at, finished_at, error)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
				)
				.run(
					run.id,
					run.state,
					run.stage,
					JSON.stringify(run.options),
					JSON.stringify(run.sources),
					JSON.stringify(run.steps),
					run.started_at,
					run.updated_at
				);
			return null;
		})
		.immediate();
}

// --- the ingest step's skip key

/** What the ingest step's result depends on: the sources' digest, the pipeline's versions, and a stage's `meta.ingest_due` (one more run owed). */
export const ingestKey = (digest: string, versions: Record<string, number>, ingestDue: string | null = null) =>
	[digest, ...Object.entries(versions).map(([k, v]) => `${k} ${v}`), ...(ingestDue ? [`due ${ingestDue}`] : [])].join(' · ');

/** The key of the latest update (newest first) whose ingest step ran to the end, if any. */
export const lastIngestKey = (runs: readonly SyncRun[]) =>
	runs.find((r) => r.state === 'finished' && ['done', 'warning'].includes(r.steps.find((s) => s.id === 'ingest')?.status ?? ''))?.options
		.ingestKey;

/**
 * Backfill failures that aren't about the record: the read, the worker, the database or the bucket.
 * They aren't kept in ingest_state, so the next backfill must try those prints again.
 */
const TRANSIENT_FAILURES = new Set(['fetch', 'read', 'worker', 'parse', 'storage', 'internal']);

/** The backfill's `--json` result. */
export interface BackfillResult {
	id: string;
	state: string;
	total: number;
	done: number;
	analysed: number;
	failed: number;
	/** Each print's one outcome, beside analysed and failed (absent from a backfill older than these fields). */
	reindexed?: number;
	viewer?: number;
	favorites?: number;
	unchanged?: number;
	/** Known failures, skipped until their record changes. */
	skipped?: number;
	/** The refold at the end: prints now folded into an earlier copy, and prints no longer folded. */
	folded?: number;
	unfolded?: number;
	failures: Record<string, number>;
}

const count = (x: number) => x.toLocaleString('en-US');

/**
 * The ingest step's summary: what the backfill did to each print. Analysed and failed always show;
 * the other outcomes only when some print had them ("18,046 re-indexed, 0 analysed, 0 failed, 180
 * known failures skipped").
 */
export function backfillSummary(r: BackfillResult) {
	if (r.unchanged === undefined)
		return `${count(r.analysed)} analysed, ${count(r.failed)} failed, ${count(r.done - r.analysed - r.failed)} unchanged or known failures`;
	const some = (x: number | undefined, what: string) => (x ? [`${count(x)} ${what}`] : []);
	return [
		...some(r.reindexed, 're-indexed'),
		...some(r.viewer, 'viewer files rebuilt'),
		...some(r.favorites, 'favourite counts updated'),
		`${count(r.analysed)} analysed`,
		`${count(r.failed)} failed`,
		...some(r.unchanged, 'unchanged'),
		...some(r.skipped, 'known failures skipped')
	].join(', ');
}

/** Whether a backfill leaves nothing to retry: it finished, and every failure is the record's own (kept in ingest_state). */
export const backfillComplete = (r: BackfillResult) =>
	r.state === 'finished' && Object.entries(r.failures).every(([kind, n]) => n === 0 || !TRANSIENT_FAILURES.has(kind));

/**
 * How one polled site's admission (`polled --json`, scripts/polled.ts) leaves the ingest step, by the same rule
 * as the backfill (a finished backfill with failed prints is a warning): 'failed' only when it crashed, gave no
 * result, or a deletion failed part-way (a purge that may have left the stage half done); stopped when asked to;
 * records that failed after their retries are a warning, since the next update retries them (they aren't in
 * the stage's ledger), so the steps that need ingest (authors, render) still run. Refusals and waiting
 * deletions are warnings too.
 */
export const polledAdmitStatus = (
	code: number | null,
	r: Pick<PolledAdmitResult, 'ok' | 'stopped' | 'finished' | 'counts' | 'gone'> | null
): 'done' | 'warning' | 'failed' | 'stopped' => {
	if (!r) return 'failed';
	if (r.stopped) return 'stopped';
	if (r.ok && code === 0)
		return r.counts.blocked || r.counts.undecodable || r.counts.refetch || r.gone.waiting || r.gone.edgeNotPurged ? 'warning' : 'done';
	if (r.finished && !r.gone.failed) return 'warning';
	return 'failed';
};

// --- steps

export type Outcome = Pick<SyncStep, 'status' | 'summary' | 'runId' | 'code' | 'details'>;

export interface StepContext {
	/** Aborts on Quit: for work the step does in this process (git). */
	signal: AbortSignal;
	stopping: () => boolean;
}

export interface StepDef {
	id: SyncStepId;
	/** Steps that must have ended done, warning or skipped for this one to run. */
	needs?: readonly SyncStepId[];
	/** Why this step doesn't run in this update (turned off, not this source's), or null. */
	gate?: () => string | null;
	run: (ctx: StepContext) => Promise<Outcome>;
}

export interface ScriptResult {
	code: number | null;
	/** The end of what it wrote (stdout and stderr, as they came). */
	tail: string;
}

/** A command's result as an outcome: exit 0 done, `warn` codes a warning, anything else failed. */
export const outcomeOf = (r: ScriptResult, summary: string, warn: number[] = [], failedSummary?: string): Outcome => {
	const ok = r.code === 0 || (r.code !== null && warn.includes(r.code));
	return {
		status: r.code === 0 ? 'done' : ok ? 'warning' : 'failed',
		summary: ok ? summary : (failedSummary ?? `exit ${r.code}`),
		code: r.code
	};
};

const MARK: Partial<Record<SyncStep['status'], string>> = { done: '✓', skipped: '·', warning: '!', stopped: '■' };

export interface RunnerOptions {
	db: D1Database;
	run: SyncRun;
	/** The log file (created if missing). */
	logFile: string;
	/** Where step commands run. */
	cwd: string;
	/** The command steps are run with (bun). */
	exec?: string;
	/** Copy the log to the terminal as it grows. */
	echo?: boolean;
	quitGraceMs?: number;
	heartbeatMs?: number;
}

export class SyncRunner {
	readonly run: SyncRun;
	private readonly db: D1Database;
	private readonly fd: number;
	private readonly opts: RunnerOptions;
	private child: ChildProcess | null = null;
	private stopRequests = 0;
	private abort = new AbortController();
	private beating: Promise<unknown> = Promise.resolve();
	private heartbeat: ReturnType<typeof setInterval> | null = null;
	private echoTimer: ReturnType<typeof setInterval> | null = null;
	private echoed = 0;

	constructor(opts: RunnerOptions) {
		this.opts = opts;
		this.run = opts.run;
		this.db = opts.db;
		this.fd = openSync(opts.logFile, 'a+');
		this.echoed = fstatSync(this.fd).size;
	}

	/** A line in the log (and so on the terminal). */
	say(line: string) {
		writeSync(this.fd, `${line}\n`);
	}

	stopping = () => this.stopRequests > 0;

	/** Heartbeat, terminal echo and (with `signals`) Ctrl-C, SIGTERM and SIGHUP as stop requests. */
	start({ signals = true } = {}) {
		if (signals)
			for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(s, () => this.requestStop(s === 'SIGINT' ? 'Ctrl-C' : s));
		this.heartbeat = setInterval(() => void this.beat(), this.opts.heartbeatMs ?? SYNC_HEARTBEAT_MS);
		if (this.opts.echo) this.echoTimer = setInterval(() => this.echo(), 250);
		return this.beat();
	}

	/** Pass one Ctrl-C to the current step; the second request also aborts in-process work and arms the kill. */
	requestStop(why: string) {
		this.stopRequests++;
		if (this.stopRequests === 1) {
			this.say(`■ stop requested (${why}): the current step ends cleanly, no further step starts`);
			if (this.run.state === 'running') this.run.state = 'stopping';
		} else {
			this.say(`■ stop requested again (${why}): the current step ends at once`);
			this.abort.abort();
			const child = this.child;
			if (child?.pid !== undefined)
				setTimeout(() => {
					if (this.child === child && child.exitCode === null) {
						this.say(`■ the step didn't end within ${Math.round((this.opts.quitGraceMs ?? QUIT_GRACE_MS) / 1000)} s: killed`);
						killGroup(child, 'SIGKILL');
					}
				}, this.opts.quitGraceMs ?? QUIT_GRACE_MS).unref();
		}
		if (this.child) killGroup(this.child, 'SIGINT', false);
		void this.beat();
	}

	/** Write the row and act on `control` ('stop' asks once, 'quit' twice). */
	beat() {
		return (this.beating = this.beating.then(async () => {
			this.run.updated_at = Date.now();
			try {
				const control = await writeSyncRun(this.db, this.run);
				const wanted = control === 'quit' ? 2 : control === 'stop' ? 1 : 0;
				while (this.stopRequests < wanted) this.requestStop(control === 'quit' ? 'Quit now, from the Overview' : 'from the Overview');
			} catch (e) {
				// The database was busy past its timeout: the next beat tries again.
				this.say(`! couldn't write the run row: ${e instanceof Error ? e.message : e}`);
			}
		}));
	}

	/** Run one command (`exec` with args, from `cwd`) to its end, its output into the log. */
	runScript(args: string[], env: Record<string, string> = {}): Promise<ScriptResult> {
		this.say(`$ bun ${args.join(' ')}`);
		const from = fstatSync(this.fd).size;
		return new Promise((resolve) => {
			const c = spawn(this.opts.exec ?? process.execPath, args, {
				cwd: this.opts.cwd,
				detached: true,
				stdio: ['ignore', this.fd, this.fd],
				env: { ...process.env, ...env, [SYNC_RUN_ENV]: this.run.id, FORCE_COLOR: '0' }
			});
			this.child = c;
			this.run.options.childPid = c.pid;
			void this.beat();
			const done = (code: number | null, extra = '') => {
				this.child = null;
				delete this.run.options.childPid;
				resolve({ code, tail: this.readFrom(from) + extra });
			};
			c.once('error', (e) => done(-1, `\n${e.message}`));
			c.once('close', (code, signal) => done(code ?? (signal === 'SIGKILL' ? 137 : signal ? 130 : null)));
		});
	}

	/** Run the steps in order: stopped after a stop, skipped by their gate or an unmet need, else run. */
	async runSteps(defs: readonly StepDef[]) {
		for (const def of defs) {
			const step = this.run.steps.find((s) => s.id === def.id)!;
			if (this.stopping()) {
				step.status = 'stopped';
				continue;
			}
			const unmet = (def.needs ?? [])
				.map((id) => this.run.steps.find((s) => s.id === id)!)
				.find((s) => !['done', 'warning', 'skipped'].includes(s.status));
			const why = unmet
				? `needs "${stepLabel(unmet.id).toLowerCase()}", which ${unmet.status === 'failed' ? 'failed' : "didn't finish"}`
				: def.gate?.();
			if (why) {
				Object.assign(step, { status: 'skipped', summary: why });
				this.say(`· ${stepLabel(def.id)}: ${why}`);
				continue;
			}
			step.status = 'running';
			step.startedAt = Date.now();
			this.say(`\n== ${stepLabel(def.id)}`);
			void this.beat();
			let out: Outcome;
			try {
				out = await def.run({ signal: this.abort.signal, stopping: this.stopping });
			} catch (e) {
				out = { status: 'failed', summary: e instanceof Error ? e.message : String(e) };
			}
			// Stopped mid-step: unfinished work, not a result. A failure stays a failure, unless it is the
			// stop's own exit (130: a second Ctrl-C).
			if (this.stopping() && (out.status === 'done' || out.status === 'warning' || (out.status === 'failed' && out.code === 130)))
				out = { ...out, status: 'stopped' };
			Object.assign(step, out, { finishedAt: Date.now() });
			this.say(`${MARK[out.status] ?? '✗'} ${stepLabel(def.id)}: ${out.summary ?? out.status}`);
			await this.beat();
		}
	}

	/** Close the run: its final state, the row (retried while the database is busy), the log. */
	async finish(): Promise<SyncRun> {
		if (this.heartbeat) clearInterval(this.heartbeat);
		const failed = this.run.steps.filter((s) => s.status === 'failed');
		this.run.state = this.stopping() ? 'stopped' : 'finished';
		this.run.error = failed.length ? failed.map((s) => `${stepLabel(s.id)}: ${s.summary}`).join('; ') : null;
		this.run.finished_at = Date.now();
		await this.beating;
		try {
			await retryBusy(() => {
				this.run.updated_at = Date.now();
				return writeSyncRun(this.db, this.run);
			});
		} catch (e) {
			this.say(`! couldn't write the final run row: ${e instanceof Error ? e.message : e}`);
		}
		this.say(
			`\nsync ${this.run.id}: ${this.run.state}${this.run.error ? ` (${this.run.error})` : ''} in ${Math.round((this.run.finished_at - this.run.started_at) / 1000)} s`
		);
		if (this.echoTimer) clearInterval(this.echoTimer);
		if (this.opts.echo) this.echo();
		closeSync(this.fd);
		return this.run;
	}

	private readFrom(offset: number) {
		const size = fstatSync(this.fd).size;
		const start = Math.max(offset, size - TAIL_BYTES);
		const buf = Buffer.alloc(size - start);
		readSync(this.fd, buf, 0, buf.length, start);
		return buf.toString('utf8');
	}

	private echo() {
		const size = fstatSync(this.fd).size;
		if (size <= this.echoed) return;
		const buf = Buffer.alloc(size - this.echoed);
		readSync(this.fd, buf, 0, buf.length, this.echoed);
		this.echoed = size;
		process.stdout.write(buf);
	}
}

/** A signal to a step's process group (it runs detached, as its own group), else to it alone. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals, group = true) {
	try {
		if (group && child.pid !== undefined) process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch {
		// Already gone.
	}
}
