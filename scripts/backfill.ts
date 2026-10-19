/**
 * `bun run backfill --stage local|dev|prod`: stream every print from the GitHub mirror, pinned at its
 * current commit, through the pipeline into the stage's D1 and R2. Nothing is kept on local disk
 * except what the local stage itself stores.
 *
 * - The parent fetches records and does every D1/R2 write; a pool of Bun Workers runs `planIngest`
 *   (decode, analyse, build viewer files) with a per-print timeout. A print that times out is recorded
 *   as failed with reason `timeout`, so it's skipped until its content changes.
 * - Resumable: `ingest_state` (loaded once at the start) says what's done; the change key is the same
 *   as `bun run ingest`'s.
 * - Reports to `pipeline_runs` (migration 0007) every few seconds and obeys its `control` column
 *   (/admin/pipeline): pause, resume, stop.
 *
 * `bun run backfill:status --stage …` prints the latest run(s) from that stage.
 */
import { spawn } from 'node:child_process';
import { cpus, hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { Effect, Layer } from 'effect';
import { fmtBytes, fmtDuration, RateWindow, etaSeconds, sampleBySize, statusLine, statusLines } from '#lib/server/pipeline/backfill.js';
import { OFFLINE_MAX_INFLATED_BYTES } from '#lib/server/pipeline/decode.js';
import { applyPlan, planFailure, type IngestOptions, type IngestOutcome, type IngestPlan } from '#lib/server/pipeline/pipeline.js';
import { RawStore, RawStoreR2 } from '#lib/server/pipeline/raw-store.js';
import { loadIngestStates, PrintRepository, PrintRepositoryD1 } from '#lib/server/pipeline/repository.js';
import {
	clearControl,
	failureBucket,
	HEARTBEAT_MS,
	isStale,
	latestRuns,
	newRunId,
	writeRun,
	type PipelineRun,
	type RunControl
} from '#lib/server/pipeline/runs.js';
import { listMirror, MirrorFetcher, rawUrl, resolveCommit, type MirrorEntry } from './backfill/mirror';
import { ComputePool, ComputeTimeout } from './backfill/pool';
import { openTarget, STAGES, TargetError, type Stage, type Target } from './backfill/stage';
import { Terminal, type Key } from './backfill/terminal';

const USAGE = `usage: bun run backfill --stage local|dev|prod [options]
       bun run backfill:status --stage local|dev|prod [--runs N]

  --stage S          local = the miniflare state \`bun run dev\` uses; dev/prod = the deployed stage (docs/deploy.md)
  --limit N          a test sample of N prints spread evenly over the mirror sorted by size, so it always includes
                     the smallest and the largest record (deterministic for a given mirror commit)
  --ids a,b,c        just these prints (must be in the mirror)
  --concurrency N    prints in flight (fetch → compute → write), default 8
  --workers N        compute workers, default min(concurrency, cores − 2)
  --timeout S        seconds of compute per print before it's killed and recorded as failed (timeout), default 10
  --force            re-analyse even unchanged prints
  --retry-failed     retry prints that failed before, even if unchanged
  --db N             D1 generation for dev/prod (default: DATABASES.<stage>.bound in alchemy.run.ts)
  --yes              don't ask before writing to prod

keys (TTY): p pause · r resume · s stop after in-flight · q quit now · Ctrl-C stop, twice quit now`;

const FACETS_EVERY_MS = 3 * 60_000;
const SAMPLE_EVERY_MS = 1000;

const fail = (message: string): never => {
	console.error(message);
	process.exit(2);
};

const STRING_FLAGS = ['stage', 'limit', 'ids', 'concurrency', 'workers', 'timeout', 'db', 'runs'];
/** `--ids -KYp…` as `--ids=-KYp…`: print ids often start with "-", which parseArgs would take for a flag. */
const argv: string[] = [];
for (const [i, arg] of process.argv.slice(2).entries()) {
	const previous = argv[argv.length - 1];
	if (i > 0 && previous?.startsWith('--') && STRING_FLAGS.includes(previous.slice(2))) argv[argv.length - 1] = `${previous}=${arg}`;
	else argv.push(arg);
}
const { values: flags } = parseArgs({
	args: argv,
	options: {
		stage: { type: 'string' },
		limit: { type: 'string' },
		ids: { type: 'string' },
		concurrency: { type: 'string' },
		workers: { type: 'string' },
		timeout: { type: 'string' },
		db: { type: 'string' },
		runs: { type: 'string' },
		force: { type: 'boolean', default: false },
		'retry-failed': { type: 'boolean', default: false },
		yes: { type: 'boolean', default: false },
		status: { type: 'boolean', default: false },
		help: { type: 'boolean', short: 'h', default: false }
	},
	strict: true
});
if (flags.help) {
	console.log(USAGE);
	process.exit(0);
}
const stage = flags.stage as Stage;
if (!STAGES.includes(stage)) fail(`--stage local|dev|prod is required\n\n${USAGE}`);
const positive = (name: string, value: string | undefined, fallback: number) => {
	if (value === undefined) return fallback;
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fail(`--${name} must be a positive number`);
};
const generation = flags.db === undefined ? undefined : positive('db', flags.db, 1);

const term = new Terminal();
const now = () => Date.now();

// ---------------------------------------------------------------------------------------------
// backfill:status

if (flags.status) {
	const target = await openTarget(stage, { generation }).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
	try {
		const runs = await latestRuns(target.env.DB, positive('runs', flags.runs, 1));
		if (runs.length === 0) console.log(`no pipeline runs in ${target.database}`);
		for (const run of runs) {
			const stale = isStale(run)
				? `${run.state}, but no heartbeat for ${fmtDuration((now() - run.updated_at) / 1000)}: crashed?`
				: undefined;
			console.log(`${statusLines(run, now(), { note: stale }).join('\n')}\n`);
		}
	} finally {
		await target.dispose();
	}
	process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// backfill

const concurrency = positive('concurrency', flags.concurrency, 8);
const workers = positive('workers', flags.workers, Math.max(1, Math.min(concurrency, cpus().length - 2)));
const timeoutMs = Math.round(positive('timeout', flags.timeout, 10) * 1000);
const limit = flags.limit === undefined ? undefined : positive('limit', flags.limit, 1);
const ids = flags.ids
	?.split(',')
	.map((s) => s.trim())
	.filter(Boolean);
const ingestOptions: IngestOptions = {
	force: flags.force,
	retryFailed: flags['retry-failed'],
	maxInflatedBytes: OFFLINE_MAX_INFLATED_BYTES
};

// Target first, so "not deployed yet" fails before anything else happens.
let target: Target;
try {
	target = await openTarget(stage, { generation, log: (line) => term.log(line) });
} catch (e) {
	fail(
		e instanceof TargetError ? `✗ ${e.message}` : `✗ couldn't open ${stage}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`
	);
	throw e;
}
term.log(`target: ${stage} · D1 ${target.database} · R2 ${target.bucket}`);

// Source: the mirror at one commit.
const t = performance.now();
const listing = await (async () => {
	const sha = await resolveCommit();
	const entries = await listMirror(sha);
	const source = `mirror@${sha.slice(0, 7)}`;
	term.log(`${source}: ${entries.length.toLocaleString('en-US')} prints listed in ${((performance.now() - t) / 1000).toFixed(1)} s`);
	if (ids) {
		const byId = new Map(entries.map((e) => [e.id, e]));
		const missing = ids.filter((id) => !byId.has(id));
		if (missing.length) throw new Error(`not in ${source}: ${missing.join(', ')} (the backfill never reads Firebase)`);
		return { sha, entries, source, targets: ids.map((id) => byId.get(id)!) };
	}
	if (limit === undefined) return { sha, entries, source, targets: entries };
	const targets = sampleBySize(entries, limit);
	const sizes = targets.map((e) => e.size).sort((a, b) => a - b);
	term.log(`sample: ${targets.length} prints spread by size, ${fmtBytes(sizes[0] ?? 0)} … ${fmtBytes(sizes[sizes.length - 1] ?? 0)}`);
	return { sha, entries, source, targets };
})().catch(async (e: unknown) => {
	await target.dispose();
	return fail(`✗ ${e instanceof Error ? e.message : String(e)}`);
});
const { sha, entries, source, targets } = listing;

if (stage === 'prod' && !flags.yes) {
	if (!term.tty) {
		await target.dispose();
		fail('refusing to write to prod without a terminal to confirm in: pass --yes');
	}
	const answer = await term.ask(`Write ${targets.length.toLocaleString('en-US')} prints from ${source} to PROD? Type "prod" to continue: `);
	if (answer !== 'prod') {
		await target.dispose();
		fail('not confirmed; nothing written');
	}
}

const { DB: db, RAW: bucket } = target.env;

// Real D1 rows written (meta.rows_written) and R2 puts, as the writes happen.
const counters = { rows: 0, overheadRows: 0, r2Objects: 0, r2Bytes: 0 };
const repoLayer = PrintRepositoryD1(db, {
	onWrite: (op, rows) => {
		if (op === 'rebuildFacets') counters.overheadRows += rows;
		else counters.rows += rows;
	}
});
const rawLayer = Layer.effect(
	RawStore,
	Effect.gen(function* () {
		const r2 = yield* RawStore;
		return {
			get: r2.get,
			delete: r2.delete,
			put: (key: string, body: string, contentType?: string) =>
				r2.put(key, body, contentType).pipe(
					Effect.tap(() =>
						Effect.sync(() => {
							counters.r2Objects++;
							counters.r2Bytes += Buffer.byteLength(body);
						})
					)
				)
		};
	})
).pipe(Layer.provide(RawStoreR2(bucket)));
const layer = Layer.merge(repoLayer, rawLayer);
const write = <A, E>(effect: Effect.Effect<A, E, PrintRepository | RawStore>) =>
	Effect.runPromise(Effect.result(Effect.provide(effect, layer)));

// The run's row.
const startedAt = now();
const run: PipelineRun = {
	id: newRunId(new Date(startedAt)),
	kind: 'backfill',
	stage,
	host: hostname(),
	source,
	options: {
		...(limit !== undefined ? { limit } : {}),
		...(ids ? { ids } : {}),
		concurrency,
		force: flags.force,
		retryFailed: flags['retry-failed'],
		workers,
		timeoutMs,
		corpus: entries.length,
		corpusBytes: entries.reduce((sum, e) => sum + e.size, 0)
	},
	state: 'starting',
	control: null,
	total: targets.length,
	done: 0,
	analysed: 0,
	viewer: 0,
	reindexed: 0,
	unchanged: 0,
	favorites: 0,
	failed: 0,
	skipped_failed: 0,
	failures: {},
	rows_written: 0,
	r2_objects: 0,
	r2_bytes: 0,
	source_bytes: 0,
	rate: null,
	eta_seconds: null,
	started_at: startedAt,
	updated_at: startedAt,
	finished_at: null,
	error: null
};
const rowOf = (r: PipelineRun) => {
	const { control: _control, ...rest } = r;
	return { ...rest, options: JSON.stringify(r.options), failures: JSON.stringify(r.failures) };
};

type Mode = 'running' | 'paused' | 'stopping';
/** An object, so TypeScript doesn't narrow it: key and heartbeat callbacks change it. */
const ctl: { mode: Mode } = { mode: 'running' };
let quitting = false;
const rate = new RateWindow();
rate.reset(startedAt, 0);
const fetcher = new MirrorFetcher(sha);
const abort = new AbortController();
let slowest: { id: string; ms: number; bytes: number } | null = null;
const inFlight = new Set<Promise<void>>();

let wakeUp = () => {};
const nextWake = () => new Promise<void>((resolve) => (wakeUp = resolve));

const refresh = () => {
	run.rows_written = counters.rows;
	run.r2_objects = counters.r2Objects;
	run.r2_bytes = counters.r2Bytes;
	run.rate = rate.rate() ?? (run.done ? (run.done * 1000) / Math.max(1, now() - startedAt) : null);
	run.eta_seconds = ctl.mode === 'running' ? etaSeconds(run.total - run.done, run.rate) : null;
	run.updated_at = now();
};

const draw = () => {
	if (!term.tty) return;
	refresh();
	const note =
		ctl.mode === 'stopping'
			? `stopping: ${inFlight.size} in flight`
			: ctl.mode === 'paused' && inFlight.size
				? `pausing: ${inFlight.size} in flight`
				: undefined;
	term.draw(
		statusLines(run, now(), {
			slowest,
			overheadRows: counters.overheadRows,
			fetch: fetcher.describe(),
			inFlight: inFlight.size,
			note
		})
	);
};

let beating: Promise<void> | null = null;
/** Write the row and act on `control`. */
const beat = () =>
	finished
		? Promise.resolve()
		: (beating ??= (async () => {
				try {
					refresh();
					const control = await writeRun(db, rowOf(run));
					counters.overheadRows++;
					if (control) {
						onControl(control, 'admin page');
						await clearControl(db, run.id, control);
						refresh();
						await writeRun(db, rowOf(run));
						counters.overheadRows++;
					}
				} catch (e) {
					term.log(`! heartbeat failed: ${e instanceof Error ? e.message : String(e)}`);
				} finally {
					beating = null;
				}
			})());

function onControl(control: RunControl, from: string) {
	if (control === 'pause' && ctl.mode === 'running') {
		ctl.mode = 'paused';
		run.state = 'paused';
		term.log(`⏸ paused (${from}): no new prints; ${inFlight.size} in flight finish. r or the admin page resumes.`);
	} else if (control === 'resume' && ctl.mode === 'paused') {
		ctl.mode = 'running';
		run.state = 'running';
		rate.reset(now(), run.done);
		term.log(`▶ resumed (${from})`);
	} else if (control === 'stop' && ctl.mode !== 'stopping') {
		ctl.mode = 'stopping';
		run.state = 'stopping';
		term.log(`■ stopping (${from}): finishing ${inFlight.size} in flight`);
	} else return;
	wakeUp();
}

// Outcomes.
const logFailure = (id: string, reason: string, tracked: boolean) =>
	term.log(`✗ ${id} ${reason}${tracked ? '' : ' (not recorded: retried next run)'}`);

const recordOutcome = (o: IngestOutcome) => {
	run.done++;
	if (o.status === 'skipped-failed') run.skipped_failed++;
	else run[o.status]++;
	if (o.status === 'failed') {
		run.failures[failureBucket(o.reason)] = (run.failures[failureBucket(o.reason)] ?? 0) + 1;
		logFailure(o.id, o.reason, true);
	}
};

/** Errors that `ingest_state` doesn't track (fetch, bad JSON, storage): counted as failed in this run only. */
const recordError = (id: string, reason: string) => {
	run.done++;
	run.failed++;
	run.failures[failureBucket(reason)] = (run.failures[failureBucket(reason)] ?? 0) + 1;
	logFailure(id, reason, false);
};

const message = (e: unknown): string => {
	if (e && typeof e === 'object' && '_tag' in e) {
		const tagged = e as { _tag: string; op?: string; cause?: unknown };
		return `${tagged._tag}${tagged.op ? ` ${tagged.op}` : ''}: ${message(tagged.cause)}`;
	}
	return e instanceof Error ? e.message : String(e);
};

const processOne = async (entry: MirrorEntry) => {
	const { id } = entry;
	let text: string;
	try {
		({ text } = await fetcher.fetch(entry, abort.signal));
	} catch (e) {
		if (!quitting) recordError(id, `fetch: ${message(e)}`);
		return;
	}
	const state = states.get(id) ?? null;
	let plan: IngestPlan;
	try {
		const result = await pool!.run({ id, text, sourceUrl: rawUrl(sha, entry.path), state, options: ingestOptions });
		if (!slowest || result.ms > slowest.ms) slowest = { id, ms: result.ms, bytes: entry.size };
		if (!result.ok) return recordError(id, result.reason!);
		plan = result.plan!;
	} catch (e) {
		if (quitting) return;
		if (!(e instanceof ComputeTimeout)) return recordError(id, `worker: ${message(e)}`);
		if (!slowest || e.ms > slowest.ms) slowest = { id, ms: e.ms, bytes: entry.size };
		const failed = await Effect.runPromise(Effect.result(planFailure(id, text, state, `timeout: analysis took over ${e.ms / 1000} s`)));
		if (failed._tag === 'Failure') return recordError(id, `parse: ${message(failed.failure)}`);
		plan = failed.success;
	}
	// Every write is idempotent, so a transient D1/R2 error is retried a couple of times.
	for (let attempt = 0; ; attempt++) {
		const result = await write(applyPlan(plan));
		if (quitting) return;
		if (result._tag === 'Success') {
			// Mirror bytes behind prints that wrote something, for scaling R2 projections (fullRunEstimate).
			if (['analysed', 'failed', 'viewer', 'reindexed', 'favorites'].includes(result.success.status)) run.source_bytes += entry.size;
			return recordOutcome(result.success);
		}
		if (attempt >= 2) return recordError(id, `storage: ${message(result.failure)}`);
		await sleep(1000 * 2 ** attempt);
	}
};

// Facet counts, so the site's sidebar looks right mid-run.
let rowsAtFacets = 0;
let facets: Promise<void> | null = null;
const rebuildFacets = () =>
	(facets ??= (async () => {
		if (counters.rows === rowsAtFacets) return;
		rowsAtFacets = counters.rows;
		const result = await write(
			Effect.gen(function* () {
				yield* (yield* PrintRepository).rebuildFacets();
			})
		);
		if (result._tag === 'Failure') term.log(`! rebuildFacets failed: ${message(result.failure)}`);
	})().finally(() => (facets = null)));

const timers: ReturnType<typeof setInterval>[] = [];
let pool: ComputePool | undefined;
let states: Awaited<ReturnType<typeof loadIngestStates>>;
let finished = false;

const finish = async (state: 'finished' | 'stopped' | 'failed', error: string | null = null) => {
	if (finished) return;
	finished = true;
	for (const timer of timers) clearInterval(timer);
	await beating;
	refresh();
	run.state = state;
	run.error = error;
	run.finished_at = now();
	run.rate = run.done ? (run.done * 1000) / Math.max(1, run.finished_at - startedAt) : null;
	run.eta_seconds = null;
	try {
		await writeRun(db, rowOf(run));
	} catch (e) {
		term.log(`! couldn't write the final run row: ${message(e)}`);
	}
	if (term.tty) term.draw(statusLines(run, now(), { slowest, overheadRows: counters.overheadRows, fetch: fetcher.describe() }));
	else console.log(statusLines(run, now(), { slowest, overheadRows: counters.overheadRows, fetch: fetcher.describe() }).join('\n'));
	term.freeze();
	term.close();
};

/** q, a second Ctrl-C: abandon in-flight prints (their writes are ordered, so nothing claims missing files) and mark the run stopped. */
const quitNow = async () => {
	if (quitting) return;
	quitting = true;
	term.log('✋ quitting now: in-flight prints are abandoned and picked up by the next run');
	abort.abort();
	pool?.close();
	const done = finish('stopped');
	await Promise.race([done, sleep(15_000)]);
	await Promise.race([target.dispose(), sleep(5_000)]);
	process.exit(130);
};

let interrupts = 0;
const onKey = (key: Key) => {
	if (key === 'pause') onControl('pause', 'key');
	else if (key === 'resume') onControl('resume', 'key');
	else if (key === 'stop') onControl('stop', 'key');
	else if (key === 'quit') void quitNow();
	else if (++interrupts === 1) {
		onControl('stop', 'Ctrl-C');
		term.log('  (Ctrl-C again to quit now)');
	} else void quitNow();
	void beat();
};
term.onKey(onKey);
process.on('SIGINT', () => onKey('interrupt'));
process.on('SIGTERM', () => onKey('interrupt'));

try {
	await writeRun(db, rowOf(run));
	term.log(
		`run ${run.id}: ${targets.length.toLocaleString('en-US')} prints · ${concurrency} in flight · ${workers} workers · timeout ${timeoutMs / 1000} s`
	);

	const t1 = performance.now();
	states = await loadIngestStates(db);
	term.log(`ingest_state: ${states.size.toLocaleString('en-US')} rows loaded in ${((performance.now() - t1) / 1000).toFixed(1)} s`);

	// On macOS, keep the machine awake for as long as this process lives.
	if (process.platform === 'darwin') spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref();

	pool = new ComputePool(workers, timeoutMs);
	if (ctl.mode === 'running') run.state = 'running';
	await beat();
	timers.push(setInterval(() => void beat(), HEARTBEAT_MS));
	timers.push(setInterval(() => ctl.mode === 'running' && rate.add(now(), run.done), SAMPLE_EVERY_MS));
	timers.push(setInterval(() => void rebuildFacets(), FACETS_EVERY_MS));
	timers.push(setInterval(term.tty ? draw : () => (refresh(), console.log(statusLine(run, now()))), term.tty ? 500 : 10_000));
	draw();

	let next = 0;
	while (!quitting && ctl.mode !== 'stopping' && next < targets.length) {
		if (ctl.mode === 'paused' || inFlight.size >= concurrency) {
			await Promise.race([nextWake(), ...inFlight]);
			continue;
		}
		const entry = targets[next++];
		const task: Promise<void> = processOne(entry)
			.catch((e: unknown) => recordError(entry.id, `internal: ${message(e)}`))
			.finally(() => inFlight.delete(task));
		inFlight.add(task);
	}
	await Promise.all(inFlight);
	if (quitting) await new Promise(() => {});
	pool?.close();
	await facets;
	await rebuildFacets();
	await finish(ctl.mode === 'stopping' ? 'stopped' : 'finished');
} catch (e) {
	pool?.close();
	await finish('failed', message(e));
	console.error(e);
	await target.dispose();
	process.exit(1);
}
await target.dispose();
process.exit(0);
