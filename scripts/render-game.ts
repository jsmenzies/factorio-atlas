/**
 * Offline game-look renders with fpsr: a durable, resumable, parallel queue of blueprint pages.
 *
 *   bun run render --from-clone <mirror clone>      # every print in a local clone of the mirror
 *   bun run render --from-disk [dir]                # raw records saved by `bun run ingest` (data/raw/factorioprints)
 *     --ids a,b,…  |  --ids-file <file>             # only these prints (one id per line in the file)
 *     --limit N                                     # the first N prints that have a 2.0+ page
 *     --next N                                      # a batch: the next N prints that still have work (run it again for the next N)
 *     --top N                                       # the N most-favourited prints too, first, pre-2.0 pages included (below)
 *     --refresh-top                                 # recompute the top list from the source first (with --top)
 *     --force                                       # render again even when nothing changed
 *     --retry-failed                                # queue again pages that failed every attempt (not kept by --resume)
 *     --plan-only                                   # enqueue (decode every print, write the rows) and exit without rendering
 *     --upload local|prod                           # put each finished page into a RENDERS bucket as the run goes
 *     --upload-concurrency N                        # upload requests in flight (default 32)
 *     --flags                                       # with --upload: then render:flags for that stage, and a page-cache bump (below)
 *     --no-thumbs                                   # don't make (or upload) page thumbnails
 *     --thumb-jobs N                                # prints whose thumbnails are made at once (default 1)
 *   bun run render --resume [flags]                 # a new run with the latest run's options (flags given override them)
 *     --workers N                                   # render processes (default: half the CPU threads)
 *     --encode-parallel N                           # AVIF encodes in flight per worker (default 4)
 *     --mem-cap-mb N                                # kill a worker past this resident size (default 6144)
 *     --recycle-mb N                                # restart a worker between pages past this (default 3072)
 *     --mem-budget-mb N                             # start pages only while the workers' memory and estimates fit (default 70% of RAM)
 *     --mem-reserve-mb N                            # and only while that much RAM stays free (default the larger of 2 GB and 10% of RAM)
 *     --timeout-scale X                             # multiply the per-page timeout (default 1)
 *
 * Assets: FPSR_ASSETS_DIR (required): an fpsr `assets-out/<game version>` folder, built by fpsr's
 * `pnpm assets:build` from an installed Factorio.
 *
 * How it works:
 * - One `render_runs` row per run and one `render_jobs` row per blueprint page, in the local D1
 *   (getPlatformProxy, the same state `vite dev` uses; /admin/render reads both). The run row is
 *   rewritten every 2 s (counts, pages/s over the last 5 minutes and the ETA from
 *   scripts/render/progress.ts, prints finished of the prints it works on, upload speed) and its
 *   `control` column pauses, resumes or stops the run between pages. SIGINT/SIGTERM stop it the same way; a second
 *   one aborts the pages in flight.
 * - Each page gets an input key: sha256 of its blueprint JSON as rendered (scripts/render/prepare.ts),
 *   the asset bundle, fpsr's version and the render settings (scripts/render/settings.ts). A page whose sidecar on disk has
 *   that key is `unchanged` and never drawn again. The key is checked with the asset bundle the sidecar names, so a new
 *   bundle (a game update) draws only pages with no render yet (`drawnKey`). Prints with no page saved in 2.0+ get no rows
 *   (they are only counted in the log), unless they are favourites (below). Other pages are
 *   `skipped` when not saved in 2.0+ ('pre-2.0', a book mixing versions; not for favourites),
 *   when they have nothing to draw ('empty'), or when they
 *   place an entity or tile fpsr has no sprites for ('modded: …'). A print whose string can't be decoded
 *   (mostly the pre-0.15 format) gets one skipped row ('undecodable: …').
 * - Pages render in worker processes (scripts/render/worker.ts) with a timeout scaled by entity
 *   count and a memory cap; a crash, hang or error fails that page only. Memory (scripts/render/memory.ts):
 *   a worker's size is its footprint, anonymous memory plus shared memory, counting the memfd that
 *   Mesa's llvmpipe keeps for skia-canvas's Vulkan canvases (it only grows, and RSS misses the part
 *   not mapped). A page's expected peak is the larger of a fresh worker's estimate and its worker's
 *   footprint plus what the page adds. A page starts only when (1) the workers' footprints, each busy
 *   one at least at its expected peak, plus the new page's growth fit in --mem-budget-mb, and (2) on Linux,
 *   MemAvailable less what the pages in flight and the new one may still grow stays above
 *   --mem-reserve-mb. Otherwise the run waits (logged every 30 s) until a page ends or memory frees
 *   up; with no page in flight one always starts. --workers is lowered, with a warning, when RAM less
 *   the reserve can't hold that many workers drawing even a small page. Workers set their
 *   oom_score_adj to 1000, so if memory still runs out the kernel kills a worker, never the runner:
 *   its page counts a crashed attempt and is retried, the worker is replaced, and no page starts for
 *   30 s while others are in flight. Up to 3 attempts, then
 *   the row is left 'failed' with the error and the run goes on. Later runs leave it failed, without
 *   drawing it, while its input key is the same; a new key, --force or --retry-failed queues it again.
 *   Rows a killed run left in 'rendering' go back to 'pending' when the next run starts.
 * - Workers write a page's files (temp file + rename) and its sidecar last; only this process
 *   writes D1 rows and each print's index.json, from render_jobs.
 * - Files are flushed to disk before they are renamed into place, so after a power cut a file is
 *   whole or absent; a sidecar is never on disk without the tiles it names.
 * - `--next N` picks a batch: prints never looked at (render_prints records each print queued, with
 *   its file's size and mtime, so finished and pre-2.0 prints aren't decoded again), or whose rows
 *   have work (pending, failed with attempts left or any failed with --retry-failed, or with --upload
 *   rendered but not up). Prints that turn out to have nothing to do don't count. The picks are
 *   recorded in the run's options.
 * - Favourites (`--top N`, scripts/render/favorites.ts): the N prints with the most
 *   `numberOfFavorites` in the source, kept in render_favorites. Every print that was ever in that
 *   table is in scope for every run, with or without the flag: its pages saved before 2.0 are
 *   rendered like the rest (fpsr migrates them by their `version`; 0.15–0.18 positions get the
 *   viewer's half-tile shift), modded and empty pages are still skipped, and it never loses its rows
 *   or files for having no 2.0+ page. A refresh that drops a print from the top N keeps its row
 *   (in_top = 0). `--top N` puts the stored top N first in the selection: with `--ids` the union,
 *   with `--next` the batch takes those with work first (prints never queued as favourites, or with
 *   pages skipped 'pre-2.0', count as work), else every print. The list is computed from the source
 *   (only `numberOfFavorites` is kept) when it is missing, shorter than N, or with --refresh-top.
 *   2.0+ pages come out the same with or without the flag: their input keys don't change.
 * - `--resume` reads the latest run's options (`options.args`): the same source, selection, workers
 *   and upload target. A batch whose pick finished resumes with exactly its prints; a `--force` run
 *   resumes forcing only the pages it left pending.
 *
 * Uploads (`--upload`, scripts/render/upload.ts; the bucket is opened in target.ts): each page that is done, rendered now or before,
 * goes into the bucket while rendering goes on: its tiles not in the bucket yet, overview, page
 * data, sidecar, then the print's index.json from the pages that are up, then its render_uploads
 * row. Pages done but not up (or up at an older version) when a run starts go up first, so a
 * restart catches up and nothing that made it up is sent again. Pause, stop and a second signal
 * apply to uploads too. `local` is the miniflare bucket `vite dev` uses; `prod` is the deployed
 * bucket through R2's S3 API, with R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (an R2 API token with
 * Object Read & Write on it) and the account from CLOUDFLARE_ACCOUNT_ID or `wrangler whoami`.
 * Exit codes: 1 the run failed (or bad flags); 2 some pages are failed (this run's, or pages earlier
 * runs left failed that it didn't queue again); 3 rendering went fine but some pages are still to upload;
 * 4 all that went fine but the `--flags` step failed.
 * `--flags` (with --upload): once the uploads are done, the upload target's `render:flags` (the
 * same code, scripts/render/stage-flags.ts: print_renders, the search filter's token, cover
 * thumbnails) and, when the run replaced a page's stamp, removed a page or scheduled any deletion,
 * a bump of the stage's page cache, so cached pages stop naming files that go after the grace period.
 * At most one bump. With `--upload prod` the flag is the consent (no typed "prod"); prod is reached
 * like render:flags does it (wrangler login, Node on PATH). It never fails the run: on failure it
 * prints the command to run by hand.
 * Files a re-render replaced (old overviews, tiles no page uses, files of removed pages) are not
 * deleted from the bucket at once: a browser or the edge may still hold a sidecar (cached 300 s) or
 * an index (60 s) that names them, and would get a 404. They wait in render_deletes for 15 minutes;
 * each upload run, as it starts and before it exits, deletes those that are due and that no page
 * in the bucket uses again (a page that goes up cancels deletions of the files it uses).
 * RENDER_DELETE_GRACE_S=<seconds> shortens the wait, for testing: below 360 s only with --upload local.
 * The run's own files in the renders folder are swept at once (the local site reads them from disk).
 *
 * Thumbnails (scripts/render/thumb-step.ts): once a print's pages are final, or at once when it has
 * nothing to draw, its page thumbnails in THUMBS_DIR are brought up to date from the overviews on disk
 * (the same code as `bun run render:thumbs`, in this process, never in a worker, `--thumb-jobs` prints
 * at a time, counted against --mem-budget-mb), so a redrawn page gets new ones and missing ones fill
 * in as runs pass over prints (`--next` picks prints by their render work only). With `--upload`
 * they go up after the print's render files, as `render:thumbs --upload` does them (thumb_uploads;
 * replaced ones through render_deletes after the same grace). `--plan-only` counts the pages that
 * need them.
 *
 * Output (<renders dir>/<id>/: RENDERS_DIR, else data/renders; layout in src/lib/viewer/game-render.ts): `<page>.<stamp>.avif` overview,
 * `<page>.json` sidecar, `<page>.page.json` entity data for the viewer's hover tooltips (from the
 * same decoded page, so it shares the render's coordinates; written for already rendered pages
 * without redrawing when PAGE_DATA_VERSION changes), `t/<hash>.avif` tiles stored once per print,
 * `index.json`. Renders from real sprites derive from Wube's art: data/renders is gitignored and
 * must stay that way. RENDERS_DIR (in .env) keeps them outside the repo; every run must use the same
 * folder, since its sidecars are what make a page `unchanged`, so a run stops when the folder has
 * none of the pages render_jobs lists as done (--force redraws into it instead).
 */
import { availableParallelism, hostname, totalmem } from 'node:os';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { RenderDb } from '@rickyzhangca/fpsr';
import { localAssets } from '@rickyzhangca/fpsr/node';
import { getPlatformProxy } from 'wrangler';
import { gameCatalog } from '#lib/viewer/catalog.server.js';
import { overviewFile, PAGE_DATA_VERSION, pageBase } from '#lib/viewer/game-render.js';
import { newRunId, type RunControl } from '#lib/server/pipeline/runs.js';
import { RENDER_HEARTBEAT_MS, type RenderJobRow } from '#lib/server/render-queue.js';
import type { PageJob, PageResult } from './render/draw.js';
import {
	commandLine,
	defaultArgs,
	parseArgs,
	resolveArgs,
	resumeArgs,
	USAGE,
	UsageError,
	type BatchRecord,
	type RecordedOptions,
	type RenderArgs
} from './render/args.js';
import { readSidecar, removePage, renameOverview, sweepTiles, writeIndex, writePageData } from './render/files.js';
import { childWorkerd, stopOrphanedWorkerd } from './render/orphans.js';
import { admit, maxWorkers, memEstimateMb, pagePeakMb, readMeminfo, type Admission, type WorkerMemory } from './render/memory.js';
import { createPool, type Outcome, type Pool, type Slot } from './render/pool.js';
import { gaveUp, MAX_ATTEMPTS, renderQueue, type DeferredUpdate, type JobWrite, type RunnerRun } from './render/queue.js';
import { favoritesCacheFile, favoritesDb, refreshFavorites, topIds, type FavoritesMeta } from './render/favorites.js';
import { entityCount, PageCache, prepared, preparedSkipped, skipReason, type Prepared } from './render/prepare.js';
import { renderProgress } from './render/progress.js';
import { batchCandidates, byPrint, isModern, takesPrint, withTopFirst } from './render/scope.js';
import { blueprintPages, cloneSource, decode, diskSource, versionString, type RecordSource } from './render/source.js';
import {
	AVIF,
	checkRendersDir,
	drawnKey,
	inputKey,
	LEVELS,
	loadAssetInfo,
	OUT_DIR,
	RENDER_SETTINGS_VERSION,
	ROOT,
	type AssetInfo
} from './render/settings.js';
import type { RenderStore } from './render/store.js';
import { deleteGraceMs, openStore } from './render/target.js';
import { createUploader, DELETE_GRACE_MS, hasUploadWork, planPrint, type Uploader, type UploadRow } from './render/upload.js';
import { thumbsDir } from '#lib/server/renders-dir.js';
import { createThumbStep, THUMB_STEP_MB, type ThumbStep } from './render/thumb-step.js';
import { createThumbUploader, thumbUploadDb } from './render/thumbs-upload.js';
import { needsPageBump, runStageFlags } from './render/stage-flags.js';

/** Decoded pages kept between enqueueing and rendering, so small runs decode each print once. */
const PAGE_CACHE_BYTES = 256 * 1024 * 1024;

// --- args

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
	console.log(USAGE);
	process.exit(0);
}
const parsed = (() => {
	try {
		return parseArgs(argv, join(ROOT, 'data', 'raw', 'factorioprints'));
	} catch (e) {
		usage(e instanceof Error ? e.message : String(e));
	}
})();
function usage(problem?: string): never {
	if (problem) console.error(problem);
	console.error(USAGE);
	process.exit(1);
}

/**
 * workerd logs every statement that meets a lock on the local database (the dev server reading the
 * same SQLite file) with a stack trace. The queue retries those (scripts/render/queue.ts) and logs
 * a write that still fails, so the trace is noise: counted, reported at the end.
 */
let busyRetries = 0;
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
	const text = args.map(String).join(' ');
	if (text.includes('workerd/util/sqlite') && text.includes('SQLITE_BUSY')) {
		busyRetries++;
		return;
	}
	consoleError(...args);
};

const proxy = await getPlatformProxy<Env>({ persist: true });
/** The proxy's workerd, recorded so that a run after a `kill -9` of this one can stop it (scripts/render/orphans.ts). */
const workerd = childWorkerd(process.pid);
const queue = renderQueue(proxy.env.DB);
/** Exit before the run row exists: close the platform proxy first (its workerd would outlive us). */
async function bail(problem: string, showUsage = false): Promise<never> {
	await proxy.dispose().catch(() => undefined);
	if (showUsage) usage(problem);
	console.error(problem);
	process.exit(1);
}

const defaults = defaultArgs({ threads: availableParallelism(), ramMb: totalmem() / 1048576 });
let args: RenderArgs;
let resumeNote: string | null = null;
let resumedFrom: string | null = null;
try {
	if (parsed.resume) {
		const latest = await queue.latestRun();
		if (!latest) await bail('--resume: there is no render run to resume yet');
		const recorded = JSON.parse(latest!.options) as RecordedOptions;
		const r = resumeArgs(recorded, latest!.id, parsed.given);
		args = r.args;
		resumeNote = r.summary;
		resumedFrom = latest!.id;
	} else args = resolveArgs(parsed.given, defaults);
} catch (e) {
	await bail(e instanceof Error ? e.message : String(e), e instanceof UsageError);
}
args = args!;
// Runs recorded before --mem-reserve-mb existed resume with the default.
args.memReserveMb ??= defaults.memReserveMb;
const { force, retryFailed, planOnly, encodeParallel, memCapMb, recycleMb, memBudgetMb, memReserveMb, timeoutScale, limit, next } = args;
/** Workers that fit in RAM less the reserve, each drawing at least a small page. */
const workerCap = maxWorkers(totalmem() / 1048576, memReserveMb, memEstimateMb(0));
const workers = Math.min(args.workers, workerCap);
/** A resumed --force: only pages still pending from the forced run are drawn again. */
const forceAll = force === true;
const forcePending = force === 'pending';

// The sidecars in OUT_DIR are what make a page `unchanged`: a run on a folder without the done
// renders (RENDERS_DIR unset or wrong) would draw them all again, so stop unless --force says to.
if (!forceAll) {
	const [sample, total] = await proxy.env.DB.batch<{ print_id?: string; n?: number }>([
		proxy.env.DB.prepare(`SELECT DISTINCT print_id FROM render_jobs WHERE status = 'done' LIMIT 50`),
		proxy.env.DB.prepare(`SELECT COUNT(*) AS n FROM render_jobs WHERE status = 'done'`)
	]);
	const problem = checkRendersDir(
		OUT_DIR,
		sample.results.map((r) => r.print_id!),
		Number(total.results[0]?.n ?? 0)
	);
	if (problem) await bail(`✗ ${problem}`);
}
console.log(`renders: ${OUT_DIR}`);

const sourceDir = resolve(args.clone ?? args.disk!);
const source: RecordSource = args.clone ? cloneSource(sourceDir) : diskSource(sourceDir);
/** The prints given (`--ids`, `--ids-file`), each once, or null for every print in the source. */
let wanted: string[] | null = args.ids && [...new Set(args.ids)];
if (args.idsFile) {
	try {
		const lines = (await readFile(args.idsFile, 'utf8')).split('\n').map((l) => l.trim());
		wanted = [...new Set(lines.filter((l) => l && !l.startsWith('#')))];
	} catch (e) {
		await bail(`--ids-file ${args.idsFile}: ${e instanceof Error ? e.message : e}`);
	}
}

// --- upload target

let store: RenderStore | null = null;
/** RENDER_DELETE_GRACE_S: a shorter grace period before replaced files are deleted, to test with the local bucket. */
let graceMs = DELETE_GRACE_MS;
try {
	store = await openStore(args.upload, proxy.env.RENDERS);
	if (store) graceMs = deleteGraceMs(process.env.RENDER_DELETE_GRACE_S, args.upload!);
} catch (e) {
	await bail(e instanceof Error ? e.message : String(e));
}

// --- assets

const loaded = await loadAssetInfo();
if (typeof loaded === 'string') await bail(loaded);
const assets: AssetInfo = loaded as AssetInfo;
const db: RenderDb = await localAssets(assets.dir).loadRenderDb('2x');
const catalog = gameCatalog();

/** Each busy worker's expected peak for its page (pagePeakMb when it started), for admission. */
const slotEstimates = new Map<Slot, number>();
/** No page starts before this while others are in flight: set when the OOM killer took a worker. */
let oomHoldUntil = 0;
const OOM_HOLD_MS = 30_000;
/** How often admission re-checks memory while it waits, and logs that it waits. */
const MEM_RETRY_MS = 2_000;
const MEM_LOG_MS = 30_000;
/** The lowest MemAvailable seen while pages were in flight, for the summary. */
let lowestAvailableMb: number | null = null;

/** Timeout per attempt: generous, since a page's size in pixels only loosely follows its entity count. */
const timeoutMs = (entities: number, attempt: number) => Math.round((120_000 + entities * 25) * timeoutScale * attempt);

// --- run state

const now = Date.now();
const batch: BatchRecord | null = next !== null ? { next, picked: [], complete: false } : null;
const runOptions = {
	assets: assets.id,
	fpsr: assets.fpsr,
	settings: RENDER_SETTINGS_VERSION,
	quality: AVIF.quality,
	effort: AVIF.effort,
	chroma: AVIF.chromaSubsampling,
	levels: LEVELS,
	workers,
	encodeParallel,
	memCapMb,
	recycleMb,
	memBudgetMb,
	memReserveMb,
	timeoutScale,
	limit,
	next,
	top: args.top,
	/** The stored top list the run used (when --top): its N, source and refresh time, and how many of its prints it added. */
	topList: null as (Pick<FavoritesMeta, 'n' | 'source' | 'refreshed_at'> & { refreshed: boolean; added: number }) | null,
	batchOf: args.batchOf,
	ids: wanted && wanted.length <= 100 ? wanted : null,
	idsCount: wanted?.length ?? null,
	force: force === true,
	forcePending,
	retryFailed,
	planOnly,
	upload: args.upload,
	uploadConcurrency: args.upload ? args.uploadConcurrency : null,
	resumedFrom,
	pid: process.pid,
	workerd,
	/** Everything `--resume` needs to start the same run again. */
	args,
	batch
};
const run: RunnerRun = {
	id: newRunId(),
	host: hostname(),
	source: source.label,
	options: JSON.stringify(runOptions),
	state: 'starting',
	total: 0,
	done: 0,
	rendered: 0,
	unchanged: 0,
	skipped: 0,
	failed: 0,
	files: 0,
	bytes: 0,
	rate: null,
	eta_seconds: null,
	started_at: now,
	updated_at: now,
	finished_at: null,
	error: null,
	upload_target: args.upload,
	uploaded: 0,
	upload_files: 0,
	upload_bytes: 0,
	upload_deleted: 0,
	uploads_pending: 0,
	upload_failed: 0,
	upload_error: null,
	upload_deletes_pending: 0,
	prints_total: 0,
	prints_done: 0,
	prints_rendered: 0,
	upload_rate_bytes: null,
	upload_rate_files: null,
	upload_rate_pages: null
};

const log = (line: string) => console.log(line);

const uploader: Uploader | null = store
	? createUploader({
			target: args.upload!,
			store,
			db: queue,
			outDir: OUT_DIR,
			concurrency: args.uploadConcurrency,
			graceMs,
			log
		})
	: null;
/** Page thumbnails (THUMBS_DIR), kept apart from the renders: made from finished overviews by the thumb step. */
const THUMBS = thumbsDir(ROOT);
if (args.thumbs && (resolve(THUMBS) === resolve(OUT_DIR) || resolve(THUMBS).startsWith(`${resolve(OUT_DIR)}/`))) {
	console.error(`THUMBS_DIR (${THUMBS}) must not be in the renders folder; set it elsewhere, or run with --no-thumbs`);
	process.exit(1);
}
const thumbUploader =
	store && args.thumbs
		? await createThumbUploader({
				store,
				db: thumbUploadDb(proxy.env.DB),
				target: args.upload!,
				dir: THUMBS,
				graceMs,
				log,
				stopped: () => stopping
			})
		: null;
/** After a print's pages are final: its thumbnails (and, uploading, their upload after its render files). */
const thumbStep: ThumbStep | null = args.thumbs
	? createThumbStep({
			rendersDir: OUT_DIR,
			thumbsDir: THUMBS,
			concurrency: args.thumbJobs,
			planOnly,
			log,
			upload: uploader && thumbUploader ? { uploader: thumbUploader, renderFilesSettled: (id) => uploader.settled(id) } : undefined,
			stopped: () => stopping
		})
	: null;

/** Upload rows of the target when the run started, by print: what enqueueing compares the rows with. */
const uploadsAtStart = new Map<string, UploadRow[]>();

let paused = false;
let stopping = false;
let aborting = false;
/** Pages/s and the ETA, from rendered and failed pages. */
const progress = renderProgress();

interface Work {
	id: string;
	path: string;
	entities: number;
	key: string;
	offset: [number, number];
	attempts: number;
	startedAt?: number;
}
const todo: Work[] = [];
let inFlight = 0;
/** Pages of each print still to finish in this run; at 0 its unused tiles are swept. */
const remaining = new Map<string, number>();
const renderedPrints = new Set<string>();
/**
 * Prints the run works on (a batch's picks, every id given and --top's list, else every print with
 * a 2.0+ page or in render_favorites) and
 * those whose every page reached a final state, for "prints N of M".
 */
const printsTracked = new Set<string>();
const printsFinished = new Set<string>();
/** Count a print in; with nothing queued to render it is finished at once. */
function trackPrint(id: string, queued: number) {
	printsTracked.add(id);
	if (!queued) printsFinished.add(id);
}
/** Decoded pages from enqueueing, while they fit in PAGE_CACHE_BYTES. */
const pageCache = new PageCache(PAGE_CACHE_BYTES);
/** Prints with no 2.0+ page: no rows (nothing to render, and they are most of the mirror), only counted. */
const preModern = { prints: 0, pages: 0 };
/** Favourites with no 2.0+ page: queued like the rest. */
const preModernFavorites = { prints: 0, pages: 0 };
/** Pages rendered before page data existed (or an older PAGE_DATA_VERSION) that got it now, without redrawing. */
let pageDataWritten = 0;
/** Overviews named `<base>.avif` (before stamps) renamed to `<base>.<stamp>.avif`, without redrawing. */
let overviewsRenamed = 0;

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

async function heartbeat() {
	const t = Date.now();
	const mem = inFlight ? await readMeminfo() : null;
	if (mem) lowestAvailableMb = Math.min(lowestAvailableMb ?? Infinity, mem.availableMb);
	const { rate, eta } = progress.rateAndEta(todo, t);
	run.rate = rate;
	run.eta_seconds = eta;
	run.updated_at = t;
	syncRun();
	const updates = deferred.splice(0);
	let control: RunControl | null;
	try {
		control = await queue.beat(run, updates);
	} catch (e) {
		deferred.unshift(...updates);
		throw e;
	}
	if (control) await actOn(control);
}

/** Row updates that can wait for the heartbeat (pages marked rendering), so the run writes in few short transactions. */
const deferred: DeferredUpdate[] = [];

/** Options (a batch's picks change as it goes) and upload counts into the run row. */
function syncRun() {
	run.options = JSON.stringify(runOptions);
	run.prints_total = printsTracked.size;
	run.prints_done = printsFinished.size;
	run.prints_rendered = renderedPrints.size;
	if (!uploader) return;
	const u = uploader.stats;
	run.uploaded = u.pages;
	run.upload_files = u.files;
	run.upload_bytes = u.bytes;
	run.upload_deleted = u.deleted;
	run.uploads_pending = uploader.pending;
	run.upload_failed = uploader.failing;
	run.upload_error = uploader.broken ?? u.lastError;
	run.upload_deletes_pending = uploader.deletesPending;
	const rates = uploader.rates();
	const round = (n: number | null, digits: number) => (n === null ? null : Math.round(n * 10 ** digits) / 10 ** digits);
	run.upload_rate_bytes = round(rates.bytes, 0);
	run.upload_rate_files = round(rates.files, 2);
	run.upload_rate_pages = round(rates.pages, 3);
}

/** Act on `control` from /admin/render (read by the heartbeat). */
async function actOn(control: RunControl) {
	if (control === 'stop') requestStop('stop requested');
	else if (control === 'pause' && !stopping && !paused) {
		paused = true;
		uploader?.setPaused(true);
		run.state = 'paused';
		log(`paused (${inFlight} pages in flight finish first); set control = 'resume' to go on`);
	} else if (control === 'resume' && paused) {
		paused = false;
		uploader?.setPaused(false);
		run.state = progress.started ? 'running' : 'starting';
		log('resumed');
	}
	syncRun();
	await queue.clearControl(run, control);
}

function requestStop(why: string) {
	if (stopping) return;
	stopping = true;
	paused = false;
	run.state = 'stopping';
	uploader?.setPaused(false);
	uploader?.stop();
	log(`${why}: finishing ${inFlight} pages in flight${uploader ? ' and the pages going up' : ''} (again to abort them)`);
}

let beating = true;
const beat = (async () => {
	let last = 0;
	while (beating) {
		await sleep(250);
		if (Date.now() - last < RENDER_HEARTBEAT_MS) continue;
		last = Date.now();
		try {
			await heartbeat();
		} catch (e) {
			log(`heartbeat failed: ${e instanceof Error ? e.message : e}`);
		}
	}
})();

/** Between units of work: wait out a pause; false once the run is stopping. */
async function checkpoint() {
	while (paused && !stopping) await sleep(250);
	return !stopping;
}

let pool = null as Pool | null;
/** Pages in flight: each settles once its row is written. */
const running = new Set<Promise<void>>();
const onSignal = (sig: string) => {
	if (!stopping) return requestStop(sig);
	if (aborting) return;
	aborting = true;
	log(`${sig} again: aborting the pages in flight (they stay pending) and their uploads (they go up next time)`);
	uploader?.abort();
	void pool?.close(0);
};
// wrangler's platform proxy installs handlers that exit at once; the run disposes the proxy itself.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
	process.removeAllListeners(sig);
	process.on(sig, () => onSignal(sig));
}

// --- enqueue

const failedRow = (id: string, title: string | null, key: string, reason: string, t: number, existing?: RenderJobRow): JobWrite => ({
	print_id: id,
	path: '',
	title,
	label: null,
	game_version: null,
	entities: 0,
	input_key: key,
	status: 'failed',
	reason,
	attempts: existing?.attempts ?? 0,
	run_id: run.id,
	files: existing?.files ?? null,
	bytes: existing?.bytes ?? null,
	ms: existing?.ms ?? null,
	overview: existing?.overview ?? null,
	stamp: existing?.stamp ?? null,
	queued_at: t,
	started_at: null,
	finished_at: t
});

/** Prints that have rows in render_jobs when the run starts: the others need no row lookup. */
let withRows = new Set<string>();
/**
 * Every print in render_favorites (in the top list now or before): in scope whatever this run's
 * flags, so it is never forgotten for having no 2.0+ page, and its pre-2.0 pages are drawn.
 */
let favorites = new Set<string>();
/** Prints `--top` added: the stored top N by rank. */
let topPicked: string[] = [];

/** Drop a print's rows and files, e.g. once it has no 2.0+ page. Never a favourite's. */
async function forgetPrint(id: string, rows: RenderJobRow[]) {
	if (!rows.length || favorites.has(id)) return;
	await queue.writeJobs([], rows);
	for (const r of rows) if (r.status === 'done') await removePage(OUT_DIR, id, r.path);
	await writeIndex(OUT_DIR, id, []);
	await sweepTiles(OUT_DIR, id);
}

/** Source stamps already read (by `--next`'s pick), so a print is stat'ed once. */
const stamps = new Map<string, string | null>();
/** render_prints rows not written yet: flushed every few hundred prints and at the end of queueing. */
const seenBuffer: { print_id: string; stamp: string | null; modern: boolean; checked_at: number }[] = [];
async function noteSeen(id: string, modern: boolean) {
	const stamp = stamps.has(id) ? stamps.get(id)! : await source.stamp(id);
	seenBuffer.push({ print_id: id, stamp, modern, checked_at: Date.now() });
	if (seenBuffer.length >= 200) await flushSeen();
}
const flushSeen = () => queue.markSeen(seenBuffer.splice(0));

/**
 * One print: rows for every page, and the pages to render queued. `taken` is false when it has no
 * 2.0+ page and isn't a favourite; such a print gets no rows at all (rows an earlier run wrote for
 * it are removed). `queued` is how many of its pages are queued to render. render_prints.modern
 * records what it would be without the favourites (has a 2.0+ page, or no decodable record).
 */
async function enqueuePrint(id: string): Promise<{ taken: boolean; queued: number }> {
	const had = withRows.has(id);
	const r = await enqueueRows(id);
	await noteSeen(id, r.modern);
	// Nothing to draw: its thumbnails can be brought up to date now (a print that lost its rows, to
	// clear them), once scheduleUpload has handed its render files to the uploader.
	if ((r.taken && r.queued === 0) || (!r.taken && had)) thumbsAfterUpload.add(id);
	return r;
}
/** Prints whose thumbnails are offered after scheduleUpload (so they go up after the render files). */
const thumbsAfterUpload = new Set<string>();

async function enqueueRows(id: string): Promise<{ taken: boolean; queued: number; modern: boolean }> {
	const t = Date.now();
	const record = await source.read(id);
	const existing = new Map((withRows.has(id) ? await queue.jobsOf(id) : []).map((r) => [r.path, r]));
	if (!record) {
		await queue.writeJobs([failedRow(id, null, 'missing', `no record in ${source.label}`, t, existing.get(''))]);
		run.total++;
		run.done++;
		run.failed++;
		return { taken: true, queued: 0, modern: true };
	}
	let decoded: unknown;
	try {
		decoded = await decode(record.blueprintString);
	} catch (e) {
		// BlueprintDecodeError carries its message in `reason`.
		const reason = (e as { reason?: unknown })?.reason;
		const why = typeof reason === 'string' ? reason : e instanceof Error ? e.message : String(e);
		// Not a failure to retry: the string will never decode (mostly the pre-0.15 format), so it can't render.
		await queue.writeJobs([
			{ ...failedRow(id, record.title, 'undecodable', `undecodable: ${why}`, t, existing.get('')), status: 'skipped' }
		]);
		run.total++;
		run.done++;
		run.skipped++;
		return { taken: true, queued: 0, modern: true };
	}
	const pages = [...blueprintPages(decoded)];
	const favorite = favorites.has(id);
	const modern = pages.some((p) => isModern(p.version));
	if (!takesPrint({ modern, favorite })) {
		preModern.prints++;
		preModern.pages += pages.length;
		await forgetPrint(id, [...existing.values()]);
		return { taken: false, queued: 0, modern };
	}
	if (!modern) {
		preModernFavorites.prints++;
		preModernFavorites.pages += pages.length;
	}

	const writes: JobWrite[] = [];
	let indexStale = false;
	let queued = 0;
	let doneHere = 0;
	for (const page of pages) {
		const old = existing.get(page.path);
		existing.delete(page.path);
		const reason = skipReason(db, page, favorite);
		const prep = reason ? preparedSkipped(page) : prepared(catalog, decoded, page);
		const key = inputKey(prep.json, assets);
		const base: Omit<JobWrite, 'status' | 'reason' | 'attempts' | 'started_at' | 'finished_at'> = {
			print_id: id,
			path: page.path,
			title: record.title,
			label: page.label,
			game_version: versionString(page.version),
			entities: entityCount(page),
			input_key: key,
			run_id: run.id,
			files: old?.files ?? null,
			bytes: old?.bytes ?? null,
			ms: old?.ms ?? null,
			overview: old?.overview ?? null,
			stamp: old?.stamp ?? null,
			queued_at: old?.queued_at ?? t
		};
		run.total++;
		if (reason) {
			run.done++;
			run.skipped++;
			if (old?.status === 'done') indexStale = true;
			if (!(old?.status === 'skipped' && old.input_key === key && old.reason === reason))
				writes.push({ ...base, status: 'skipped', reason, attempts: 0, started_at: null, finished_at: t });
			continue;
		}
		// A resumed --force redraws only what the forced run left pending.
		const forced = forceAll || (forcePending && (old?.status === 'pending' || old?.status === 'rendering'));
		let sc = forced ? null : await readSidecar(OUT_DIR, id, page.path);
		// A drawn page is measured against the assets that drew it, not the current ones (drawnKey).
		const kept = sc && sc.assets.id !== assets.id ? drawnKey(prep.json, sc.assets.id, assets) : key;
		if (sc && sc.inputKey === kept && sc.overview.file !== overviewFile(page.path, sc.stamp)) {
			// Rendered before overviews carried the stamp: renamed, no redraw. Buckets need the new
			// name (marked first, so a crash in between only re-sends the page). No overview: drawn again.
			try {
				await queue.markStale(id, page.path);
				sc = await renameOverview(OUT_DIR, id, sc);
				overviewsRenamed++;
			} catch (e) {
				log(`  ${id} ${pageBase(page.path)}: ${e instanceof Error ? e.message : e}; rendering it again`);
				sc = null;
			}
		}
		if (sc && sc.inputKey === kept) {
			run.done++;
			run.unchanged++;
			doneHere++;
			if (sc.pageData !== PAGE_DATA_VERSION) {
				// Rendered before its page data existed: write that now, no redraw. Buckets holding the
				// page need the new files: marked first, so a crash in between only re-sends them.
				await queue.markStale(id, page.path);
				await writePageData(OUT_DIR, id, sc, prep.page);
				pageDataWritten++;
			}
			if (!(old?.status === 'done' && old.input_key === kept && old.overview === sc.overview.file)) {
				// Rendered before, but the row didn't say so (a crash after the sidecar, a fresh database).
				indexStale = true;
				writes.push({
					...base,
					input_key: kept,
					status: 'done',
					reason: null,
					attempts: old?.attempts ?? 1,
					files: sc.stats.files,
					bytes: sc.stats.bytes,
					ms: sc.stats.ms,
					overview: sc.overview.file,
					stamp: sc.stamp,
					started_at: old?.started_at ?? null,
					finished_at: Date.parse(sc.renderedAt) || t
				});
			}
			continue;
		}
		if (old && !forced && !retryFailed && gaveUp(old, key)) {
			// Failed every attempt at this input: left as it is, not drawn again until the key changes.
			run.done++;
			run.failed++;
			continue;
		}
		if (old?.status === 'done') indexStale = true;
		writes.push({ ...base, status: 'pending', reason: null, attempts: 0, queued_at: t, started_at: null, finished_at: null });
		todo.push({ id, path: page.path, entities: entityCount(page), key, offset: prep.offset, attempts: 0 });
		queued++;
		if (!planOnly) pageCache.offer(id, page.path, prep);
	}
	// Rows for pages the print no longer has (it changed since), or a failed decode it got over.
	const gone = [...existing.values()];
	await queue.writeJobs(writes, gone);
	for (const g of gone) if (g.status === 'done') await removePage(OUT_DIR, id, g.path);
	if (gone.length || (doneHere && !existsSync(join(OUT_DIR, id, 'index.json')))) indexStale = true;
	if (queued) remaining.set(id, queued);
	if (indexStale || (!queued && writes.length)) await writeIndex(OUT_DIR, id, await queue.donePages(id));
	return { taken: true, queued, modern };
}

/**
 * After queueing a print: hand its upload work (rendered pages not up at their current version,
 * pages to drop from the bucket) to the uploader, then offer its thumbnails when it has nothing to
 * draw. Returns whether there was upload work.
 */
async function scheduleUpload(id: string, taken: boolean): Promise<boolean> {
	try {
		return await scheduleRenderUpload(id, taken);
	} finally {
		if (thumbsAfterUpload.delete(id)) thumbStep?.offer(id);
	}
}

async function scheduleRenderUpload(id: string, taken: boolean): Promise<boolean> {
	if (!uploader) return false;
	if (!taken && !uploadsAtStart.has(id)) return false;
	// Fresh rows: queueing may have just marked some stale (an overview renamed, page data rewritten).
	const [jobs, ups] = await Promise.all([queue.jobsOf(id), queue.uploadsOf(args.upload!, id)]);
	const plan = planPrint(jobs, ups);
	if (!hasUploadWork(plan)) return false;
	uploader.schedule(id, plan.upload.length);
	return true;
}

// --- render

/** The page as it goes to fpsr: from the cache, else decoded again (caching the print's other queued pages). */
async function pageJson(w: Work): Promise<Prepared | null> {
	const cached = pageCache.take(w.id, w.path);
	if (cached !== undefined) return cached;
	// Decode the print once for all its queued pages.
	const record = await source.read(w.id);
	if (!record) return null;
	const decoded = await decode(record.blueprintString);
	let found: Prepared | null = null;
	const others = new Set(todo.filter((x) => x.id === w.id).map((x) => x.path));
	for (const page of blueprintPages(decoded)) {
		if (page.path !== w.path && !others.has(page.path)) continue;
		const prep = prepared(catalog, decoded, page);
		if (page.path === w.path) found = prep;
		else pageCache.offer(w.id, page.path, prep);
	}
	return found;
}

/** One of the print's queued pages reached a final state. `open`: its pending or rendering pages, when the caller read them. */
async function finishPrint(id: string, open?: number) {
	const left = (remaining.get(id) ?? 1) - 1;
	remaining.set(id, left);
	if (left > 0) return;
	remaining.delete(id);
	// Every queued page is final: thumbnails from its overviews (after the index.json written above).
	thumbStep?.offer(id);
	if (printsTracked.has(id)) printsFinished.add(id);
	if (!renderedPrints.has(id) || (open ?? (await queue.openJobs(id)))) return;
	const swept = await sweepTiles(OUT_DIR, id);
	if (swept.removed) {
		const what = [
			swept.overviews ? `${swept.overviews} replaced overview${swept.overviews === 1 ? '' : 's'}` : '',
			swept.tiles ? `${swept.tiles} unused tile${swept.tiles === 1 ? '' : 's'}` : ''
		].filter(Boolean);
		log(`  ${id}: removed ${what.join(' and ')} from disk (${mb(swept.bytes)})`);
	}
}

async function complete(w: Work, o: Outcome) {
	const t = Date.now();
	if (o.ok) {
		const r: PageResult = o.result;
		const finished = await queue.finishJob(w.id, w.path, {
			status: 'done',
			reason: null,
			attempts: w.attempts,
			run_id: run.id,
			started_at: w.startedAt ?? null,
			files: r.files,
			bytes: r.bytes,
			ms: r.ms,
			overview: r.overview,
			stamp: r.stamp,
			finished_at: t,
			// The bucket holds an older version, if any.
			uploaded_at: null
		});
		run.done++;
		run.rendered++;
		run.files += r.files;
		run.bytes += r.bytes;
		progress.completed(w, t);
		renderedPrints.add(w.id);
		await writeIndex(OUT_DIR, w.id, finished.done);
		uploader?.schedule(w.id);
		log(
			`  ${w.id} ${pageBase(w.path).padEnd(6)} ${String(w.entities).padStart(6)} ents  ${r.summary}, ${mb(r.bytes)}, ${r.files} files ` +
				`(${r.tiles.reused} reused, ${r.tiles.empty} empty, ${r.tiles.unread ?? 0} never drawn), ${(r.ms / 1000).toFixed(1)} s, peak ${o.peakMb} MB`
		);
		await finishPrint(w.id, finished.open);
		return;
	}
	const why = o.error.split('\n')[0].slice(0, 2000);
	if (stopping && (o.kind === 'crash' || aborting)) {
		// Cut short by the stop, not the page's fault: next run picks it up.
		await queue.updateJob(w.id, w.path, { status: 'pending', started_at: null, attempts: w.attempts - 1 });
		return;
	}
	if (w.attempts < MAX_ATTEMPTS) {
		log(`  ${w.id} ${pageBase(w.path)} attempt ${w.attempts} failed (${o.kind}): ${why}; will retry`);
		await queue.updateJob(w.id, w.path, {
			status: 'pending',
			reason: `attempt ${w.attempts}: ${why}`,
			attempts: w.attempts,
			started_at: null
		});
		if (!stopping) todo.push(w);
		return;
	}
	log(`  ${w.id} ${pageBase(w.path)} failed after ${w.attempts} attempts (${o.kind}): ${why}`);
	await queue.updateJob(w.id, w.path, { status: 'failed', reason: why, attempts: w.attempts, run_id: run.id, finished_at: t });
	run.done++;
	run.failed++;
	progress.completed(w, t);
	// An older version of the page in the bucket leaves its index.
	if (uploadsAtStart.get(w.id)?.some((u) => u.path === w.path)) uploader?.schedule(w.id, uploader.pendingOf(w.id));
	await finishPrint(w.id);
}

/**
 * Keep the CPU busy as fewer workers have work (a run's tail is often one huge page): each busy
 * worker gets about 2 × threads ÷ busy workers encodes in flight, at least --encode-parallel.
 */
let encodesNow = 0;
function balanceEncodes() {
	const n = Math.min(16, Math.max(encodeParallel, Math.ceil((2 * availableParallelism()) / Math.max(1, inFlight))));
	if (n === encodesNow) return;
	encodesNow = n;
	pool?.setEncodeParallel(n);
}

/** Memory now, read once: whether a page may start on `slot` (memory.ts `admit`). */
async function admission(slot: Slot): Promise<(w: Work) => Admission> {
	const mem = await readMeminfo();
	if (mem && inFlight) lowestAvailableMb = Math.min(lowestAvailableMb ?? Infinity, mem.availableMb);
	const live = pool!.memory();
	const workersNow: WorkerMemory[] = live.map((m) => ({
		footprintMb: m.memMb,
		peakMb: m.busy ? (slotEstimates.get(m.slot) ?? null) : null
	}));
	const workerMb = live.find((m) => m.slot === slot)?.memMb ?? 0;
	return (w) =>
		admit({
			peakMb: pagePeakMb(w.entities, workerMb),
			workerMb,
			workers: workersNow,
			inFlight,
			// The thumb step's sharp work in this process takes from the same RAM.
			budgetMb: memBudgetMb - (thumbStep && !planOnly ? THUMB_STEP_MB * args.thumbJobs : 0),
			availableMb: mem?.availableMb ?? null,
			reserveMb: memReserveMb
		});
}

/** When admission began to wait, when it last logged that, and whether it did in this wait. */
let waitingSince = 0;
let waitLogged = 0;
let waitReported = false;
function logWait(a: Admission | 'oom') {
	const t = Date.now();
	waitingSince ||= t;
	if (t - waitLogged < MEM_LOG_MS) return;
	waitLogged = t;
	waitReported = true;
	const what =
		a === 'oom'
			? `a worker was killed for memory; holding new pages until ${new Date(oomHoldUntil).toLocaleTimeString()}`
			: a.ok
				? ''
				: a.why === 'budget'
					? `the workers would need ${a.needMb} MB, over --mem-budget-mb ${a.limitMb}`
					: `${a.availableMb} MB available, pages may still grow ${a.needMb} MB, reserve ${a.reserveMb} MB`;
	log(`  waiting for memory (${inFlight} pages in flight): ${what}`);
}

async function renderAll() {
	if (workers < args.workers) {
		log(
			`--workers ${args.workers} lowered to ${workers}: ${Math.round(totalmem() / 1048576)} MB of RAM less the ${memReserveMb} MB reserve ` +
				`holds ${workerCap} workers at ${Math.round(memEstimateMb(0))} MB each`
		);
	}
	pool = createPool({
		size: Math.min(workers, Math.max(1, todo.length)),
		init: { encodeParallel, encodeThreads: 1, outDir: OUT_DIR },
		memCapMb,
		recycleMb,
		log,
		onOom: () => {
			oomHoldUntil = Date.now() + OOM_HOLD_MS;
		}
	});
	progress.start();
	while (todo.length || running.size) {
		if (!(await checkpoint())) break;
		if (!todo.length) {
			await Promise.race(running);
			continue;
		}
		const slot = await pool.acquire();
		if (!(await checkpoint())) break;
		if (running.size && Date.now() < oomHoldUntil) {
			logWait('oom');
			await Promise.race([...running, sleep(MEM_RETRY_MS)]);
			continue;
		}
		// Biggest first (todo is sorted), unless it doesn't fit beside the pages in flight; a smaller one may.
		const fits = await admission(slot);
		const first = fits(todo[0]);
		const pick = first.ok ? 0 : todo.findIndex((x) => fits(x).ok);
		if (pick < 0 && running.size) {
			logWait(first);
			await Promise.race([...running, sleep(MEM_RETRY_MS)]);
			continue;
		}
		if (waitingSince) {
			if (waitReported) log(`  memory: starting pages again after ${((Date.now() - waitingSince) / 1000).toFixed(0)} s`);
			waitingSince = 0;
			waitReported = false;
		}
		const [w] = todo.splice(Math.max(0, pick), 1);
		if (!w) continue;
		const prep = await pageJson(w).catch((e: unknown) => {
			log(`  ${w.id} ${pageBase(w.path)}: could not read the page again: ${e instanceof Error ? e.message : e}`);
			return null;
		});
		if (prep === null || inputKey(prep.json, assets) !== w.key) {
			// The record changed under the run; the next run queues it afresh.
			await queue.updateJob(w.id, w.path, { status: 'failed', reason: 'the record changed during the run', finished_at: Date.now() });
			run.done++;
			run.failed++;
			if (uploadsAtStart.get(w.id)?.some((u) => u.path === w.path)) uploader?.schedule(w.id, uploader.pendingOf(w.id));
			await finishPrint(w.id);
			continue;
		}
		w.attempts++;
		// Marked with the next heartbeat (only if still pending then): one write fewer per page.
		w.startedAt = Date.now();
		deferred.push({
			printId: w.id,
			path: w.path,
			set: { status: 'rendering', attempts: w.attempts, run_id: run.id, started_at: w.startedAt },
			onlyIf: 'pending'
		});
		inFlight++;
		progress.began(w);
		slotEstimates.set(slot, pagePeakMb(w.entities, pool.memory().find((m) => m.slot === slot)?.memMb ?? 0));
		balanceEncodes();
		const job: PageJob = {
			id: w.id,
			path: w.path,
			json: prep.json,
			page: prep.page,
			inputKey: w.key,
			offset: w.offset,
			entities: w.entities
		};
		const p: Promise<void> = pool
			.run(slot, job, timeoutMs(w.entities, w.attempts))
			.then((o) => complete(w, o))
			.catch((e: unknown) => log(`  ${w.id} ${pageBase(w.path)}: bookkeeping failed: ${e instanceof Error ? e.message : e}`))
			.finally(() => {
				inFlight--;
				progress.ended(w);
				slotEstimates.delete(slot);
				balanceEncodes();
				running.delete(p);
			});
		running.add(p);
	}
	await Promise.all(running);
	await pool.close();
}

// --- batches (--next N)

/**
 * Queue the next `batch.next` prints that still have work, in source order (with --top, the top
 * list first, by rank). A print is a candidate
 * when it was never looked at (or its record changed since: render_prints), or its rows have work:
 * pages pending, failed with attempts left (or any, with --retry-failed), or with --upload rendered
 * but not up. A print --top added is a candidate also while it has no rows (a pre-2.0 print looked
 * at before it was a favourite) or pages skipped 'pre-2.0'. Candidates are queued one by one; those
 * that turn out to have nothing to do (modded, empty, pre-2.0, already rendered, failed every
 * attempt) are recorded and don't count. Only candidates are decoded. Returns the prints taken.
 */
async function pickBatch(ids: string[], b: BatchRecord): Promise<number> {
	const t0 = Date.now();
	const rows = byPrint(await queue.allJobs());
	const seen = await queue.seenPrints();
	for (let i = 0; i < ids.length; i += 64) {
		const chunk = ids.slice(i, i + 64);
		const got = await Promise.all(chunk.map((id) => source.stamp(id)));
		chunk.forEach((id, j) => stamps.set(id, got[j]));
	}
	const { candidates, unseen } = batchCandidates(ids, {
		rows,
		seen,
		stamps,
		uploads: uploader ? uploadsAtStart : null,
		top: topPicked,
		retryFailed
	});
	b.candidates = candidates.length;
	b.unseen = unseen;
	log(`batch: ${candidates.length} of ${ids.length} prints may have work (${b.unseen} not looked at yet), found in ${Date.now() - t0} ms`);
	let taken = 0;
	let looked = 0;
	for (const id of candidates) {
		if (b.picked.length >= b.next) break;
		if (!(await checkpoint())) break;
		looked++;
		const r = await enqueuePrint(id);
		if (r.taken) taken++;
		const uploads = await scheduleUpload(id, r.taken);
		if (r.queued > 0 || uploads) {
			b.picked.push(id);
			trackPrint(id, r.queued);
		}
	}
	b.left = candidates.length - looked;
	b.complete = !stopping;
	return taken;
}

// --- main

let exitCode = 0;
try {
	const orphans = stopOrphanedWorkerd(
		(await queue.deadRuns(run.id, run.host)).flatMap((r) => (JSON.parse(r.options) as { workerd?: number[] }).workerd ?? [])
	);
	if (orphans) log(`stopped ${orphans} workerd processes that killed runs left running`);
	const live = await queue.liveRuns(run.id, run.host);
	if (live.length) {
		throw new Error(
			`another render run is live: ${live.map((r) => `${r.id} on ${r.host}`).join(', ')} (stop it, or wait 30 s after it died)`
		);
	}
	syncRun();
	await queue.writeRun(run);
	const reset = await queue.resetStuck(run.id);
	if (resumeNote) log(resumeNote);
	log(
		`run ${run.id}: ${commandLine(args)}\n` +
			`  assets ${assets.id}, fpsr ${assets.fpsr}, source ${source.label}, ${workers} workers × ${encodeParallel} encodes` +
			(store ? `; uploading to ${store.label}, ${args.uploadConcurrency} requests at once` : '') +
			(reset ? `; ${reset} pages a stopped run left rendering are pending again` : '')
	);

	withRows = await queue.printsWithRows();
	const fdb = favoritesDb(proxy.env.DB);
	if (args.top !== null) {
		let meta = await fdb.meta<FavoritesMeta>('favorites');
		const refreshed = args.refreshTop || !meta || meta.n < args.top;
		if (refreshed) {
			const why = args.refreshTop ? '--refresh-top' : meta ? `the stored list has only ${meta.n}` : 'no list stored yet';
			meta = await refreshFavorites(fdb, source, args.top, favoritesCacheFile(join(ROOT, '.cache', 'render'), sourceDir));
			log(
				`top list (${why}): ${meta.n} most-favourited of ${meta.prints} prints in ${source.label} (at least ${meta.cutoff} favourites), ` +
					`${meta.parsed} records read in ${meta.ms} ms`
			);
		}
		topPicked = topIds(await fdb.rows(), args.top);
		runOptions.topList = { n: meta!.n, source: meta!.source, refreshed_at: meta!.refreshed_at, refreshed, added: topPicked.length };
		if (!refreshed)
			log(
				`top list: the stored top ${meta!.n} from ${meta!.source}, ${new Date(meta!.refreshed_at).toISOString()} (--refresh-top to recompute)`
			);
	}
	favorites = new Set((await fdb.rows()).map((r) => r.print_id));
	if (uploader) {
		for (const [id, list] of byPrint(await queue.allUploads(args.upload!))) uploadsAtStart.set(id, list);
		// Before any print syncs (never alongside one): replaced files whose grace period is over.
		await uploader.processDeletes();
		await thumbUploader?.processDue();
	}
	// --top: its prints first (by rank), then the selection without them.
	const ids = withTopFirst(topPicked, wanted ?? (await source.ids()));
	const enqueueStart = Date.now();
	let taken = 0;
	if (batch) taken = await pickBatch(ids, batch);
	else {
		for (const id of ids) {
			if (limit !== null && taken >= limit) break;
			if (!(await checkpoint())) break;
			const r = await enqueuePrint(id);
			if (r.taken) taken++;
			if (r.taken || wanted) trackPrint(id, r.queued);
			await scheduleUpload(id, r.taken);
		}
	}
	await flushSeen();
	// Biggest pages first, so the run doesn't end waiting on one huge page.
	todo.sort((a, b) => b.entities - a.entities);
	log(
		`queued ${todo.length} pages of ${run.total} (${run.unchanged} unchanged, ${run.skipped} skipped, ${run.failed} failed) from ${taken} prints ` +
			`in ${((Date.now() - enqueueStart) / 1000).toFixed(1)} s; ${preModern.prints} prints (${preModern.pages} pages) with no 2.0+ page left out` +
			(preModernFavorites.prints
				? `; ${preModernFavorites.prints} favourites (${preModernFavorites.pages} pages) with no 2.0+ page taken`
				: '') +
			(topPicked.length ? `\n  top list: ${topPicked.length} prints first in the selection` : '') +
			(pageDataWritten ? `; page data written for ${pageDataWritten} pages rendered before it existed` : '') +
			(overviewsRenamed ? `; ${overviewsRenamed} overviews renamed to carry their stamp` : '') +
			(batch ? `\n  batch: ${batch.picked.length} of ${batch.next} prints picked; about ${batch.left} prints may have work after it` : '') +
			(uploader ? `\n  ${uploader.pending} rendered pages to upload so far` : '')
	);

	if (planOnly) {
		// Rows stay 'pending' for the next run, which queues them again.
	} else if (!stopping) {
		run.state = paused ? 'paused' : 'running';
		await heartbeat();
		if (todo.length) await renderAll();
	}
	if (thumbStep) {
		if (!stopping && thumbStep.pending) log(`rendering done; bringing ${thumbStep.pending} prints' thumbnails up to date`);
		await thumbStep.drain();
	}
	if (uploader) {
		if (!stopping && (uploader.pending || uploader.inFlight)) log(`rendering done; waiting for ${uploader.pending} pages to upload`);
		await uploader.drain();
		// Not after a stop (it does nothing then): what's due stays for the next run.
		await uploader.processDeletes();
		if (!stopping) await thumbUploader?.processDue();
	}
	// A plan-only run leaves its pages pending: it ends 'stopped', not 'finished'.
	run.state = stopping || planOnly ? 'stopped' : 'finished';
} catch (e) {
	run.state = 'failed';
	run.error = e instanceof Error ? e.message : String(e);
	console.error(run.error);
	exitCode = 1;
	// Pages in flight go back to pending; uploads in flight go up next time.
	stopping = true;
	aborting = true;
	uploader?.abort();
	await pool?.close(0);
	await Promise.allSettled(running);
	await thumbStep?.drain();
	await uploader?.drain();
} finally {
	beating = false;
	await beat;
	run.finished_at = Date.now();
	run.updated_at = run.finished_at;
	const { rate } = progress.rateAndEta(todo, run.finished_at);
	run.rate = rate;
	run.eta_seconds = null;
	await flushSeen().catch(() => undefined);
	syncRun();
	await queue.writeRun(run).catch((e: unknown) => console.error(`could not write the run's final state: ${e}`));
	await proxy.dispose();
}
const secs = (Date.now() - run.started_at) / 1000;
log(
	`${run.state}: ${run.done}/${run.total} pages (${run.prints_done}/${run.prints_total} prints), ${run.rendered} rendered, ${run.unchanged} unchanged, ${run.skipped} skipped, ${run.failed} failed; ` +
		`${run.files} files, ${mb(run.bytes)} in ${secs.toFixed(0)} s` +
		(pool ? `; worker peak ${pool.peakMb} MB` : '') +
		(lowestAvailableMb !== null ? `, lowest MemAvailable ${lowestAvailableMb} MB` : '') +
		(pool?.oomKilled ? `; ${pool.oomKilled} workers killed by the kernel for memory` : '') +
		(busyRetries ? `\nthe local database was busy ${busyRetries} times (another process reading it); every statement was retried` : '') +
		(thumbStep ? `\n${thumbSummary()}` : '') +
		(uploader
			? `\nuploads: ${run.uploaded} pages, ${run.upload_files} files, ${mb(run.upload_bytes)}, ${run.upload_deleted} deleted; ` +
				`${uploader.stats.deletesScheduled} deletions scheduled / ${run.upload_deletes_pending} pending` +
				(uploader.nextDue ? ` (next due ${new Date(uploader.nextDue).toLocaleTimeString()})` : '') +
				'; ' +
				`${run.uploads_pending} pages still to upload${run.upload_failed ? ` (${run.upload_failed} failing: ${run.upload_error})` : ''}` +
				(uploader.broken ? `\nuploads stopped: ${uploader.broken}` : '')
			: '')
);
/** One line on the thumb step's work. */
function thumbSummary() {
	const t = thumbStep!.stats;
	if (planOnly) return `thumbnails: ${t.pages} pages to make; ${t.current} of ${t.prints} prints looked at are up to date (${THUMBS})`;
	const u = thumbUploader?.stats;
	return (
		`thumbnails: ${t.pages} pages made (${t.files} files, ${mb(t.bytes)}), ${t.current} of ${t.prints} prints up to date, ` +
		`${t.removed} old files deleted from disk${t.cleared ? `, ${t.cleared} prints cleared` : ''}${t.failed ? `, ${t.failed} pages FAILED` : ''}` +
		(u
			? `; uploaded ${u.uploaded} prints (${u.files} files, ${mb(u.bytes)}), ${u.deletesScheduled} deletions scheduled, ${u.deleted} due ones deleted` +
				(u.failed ? `, ${u.failed} failed` : '')
			: '')
	);
}
const uploadsLeft = uploader && (uploader.broken || run.uploads_pending > 0);
const flagsFailed = uploader && args.flags ? !(await flagsStep()) : false;
process.exit(exitCode || (run.failed ? 2 : 0) || (uploadsLeft ? 3 : 0) || (flagsFailed ? 4 : 0));

/**
 * `--flags`: the upload target's render flags and cover thumbnails (`render:flags`, the same code),
 * and a page-cache bump when the run replaced or removed files cached pages may name. Last, after
 * the run's state is saved, and never fatal: a failure prints the command to run by hand.
 */
async function flagsStep(): Promise<boolean> {
	const u = uploader!.stats;
	const bump = needsPageBump({
		replaced: u.replaced,
		removed: u.removed,
		renderDeletes: u.deletesScheduled,
		thumbDeletes: thumbUploader?.stats.deletesScheduled ?? 0
	});
	log(`flags: render:flags --stage ${args.upload}${bump ? ', and a page-cache bump' : ''}`);
	try {
		// `--flags` is the consent: no typed "prod".
		await runStageFlags(args.upload!, { confirm: async () => {}, bump, log });
		return true;
	} catch (e) {
		log(
			`flags: failed: ${e instanceof Error ? e.message : String(e)}\n` +
				`  the renders and uploads stand; run by hand: bun run render:flags --stage ${args.upload}${bump ? ' --bump' : ''}`
		);
		return false;
	}
}
