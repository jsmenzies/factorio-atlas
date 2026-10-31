/**
 * `bun run sync`: one update. Fetch every print source (today the factorioprints mirror clone), then
 * bring the stage up to date with them, using the settings saved from the admin Update tab (sync_meta
 * 'settings'; defaults in #lib/sync.js):
 *
 *   1. removals     `removals --stage S --yes --json`: this machine's copies of prints the stage
 *                   deleted (blocks into the local D1, render rows and files, thumbnails, screenshot
 *                   copies). Runs whatever else happens; when it fails, screenshots and render (which
 *                   could put a removed print's files back) are skipped and the update says so
 *   2. fetch        each source: what's new (for the mirror: GitHub's latest commit against the
 *                   clone's), then fetch it (fast-forward). Polled sites (codex, fprints; scripts/sync/polled.ts):
 *                   list until past the cursor, read new and changed records into the record store's
 *                   inbox, every one of them (no read cap), ≈ 1 request a second. A source is held back, and only
 *                   it, by the one rule (#lib/sync.js holdBack): new and removed prints (the mirror's moves too)
 *                   more than `maxChange` of the prints known from it and at least 25, or a first import
 *                   (`--accept <id>` lets one through); or when it would have no prints, or its history was
 *                   rewritten. Then `records --stage S --json`: the record store
 *                   (RECORDS_DIR, default ~/data/factorio-records) brought in line with every other
 *                   site's records on the stage (today live uploads), for the render step
 *   3. ingest       `backfill --stage S --from-clone … --json`; skipped when neither the sources'
 *                   digest nor the analyzer, index or viewer version changed since the last update
 *                   that ran it to the end (a backfill with failures that aren't the records' own
 *                   doesn't count as the end). Then, per polled site that is on, `polled --stage S
 *                   --site X`: its inbox through the gate, and its deletions as sources gone; after the
 *                   backfill, so a blueprint new on factorioprints and on the site in one update joins
 *                   the factorioprints print (its id stays the URL). When it wrote, it pulls the site's
 *                   own prints into the record store, so the render step draws them
 *   4. authors      `authors --stage S` (Firebase, only authors never asked;
 *                   factorioprints only); needs ingest
 *   5. screenshots  `screenshots` (new ones from Imgur), `--from-uploads S`
 *                   (approved upload screenshots, from the stage's RAW), `--from-sites S` (images other
 *                   sites' records name, for the stage's prints showing them), `--upload S`,
 *                   `screenshots:flags --stage S`; needs removals
 *   6. render       `render:top <top>` (factorioprints only) and `render:check`, then
 *                   `render --next <perUpdate> --top <top> --upload S --flags`, reading the mirror
 *                   clone and the record store; needs ingest and removals
 *   7. figures      the stage's counts for the Overview (`--figures`)
 *
 * Each step is the existing command, run as its own process into one log in the run logs folder
 * (<renders dir>/logs/sync-<time>.log); scripts/sync/runner.ts runs them (the `sync_runs` row,
 * heartbeat, stopping, gating). A step that fails is marked so and the steps that don't need it
 * still run. Ctrl-C, SIGTERM or the Overview's Stop ends the current step cleanly and starts no
 * more; Ctrl-C again, or Quit now, ends it at once (killed 30 s later if it hasn't ended). An update
 * refuses to start while another is live, or its processes still run, or a render run is live.
 *
 *   bun run sync [--stage prod|local] [--yes]   one update (prod asks for "prod" unless --yes)
 *   bun run sync --plan [--json]                fetch and say what an update would do (sync_meta 'plan')
 *   bun run sync --accept <commit|site|site:id> fetch a held-back change anyway (sync_meta 'accept'): a mirror
 *                                               commit, or a source the last check held back (`codex`), or that
 *                                               held change by its id (`codex:471@…`)
 *   bun run sync --figures [--stage S] [--json] count what the stage has (sync_meta 'figures')
 *   bun run sync --top-preview N                what a top N would add to the render scope (JSON)
 *
 * The stage defaults to prod. The mirror clone is RENDER_CLONE_DIR (default ~/data/factorio-mirror),
 * the sprites FPSR_ASSETS_DIR (default: the newest set in ~/fpsr-assets). Exit 0 when the update
 * finished with no step failed (warnings included), 1 when a step failed or it was stopped, 2 on
 * bad usage or when it refuses to start.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ANALYZER_VERSION } from '#lib/server/pipeline/analyze.js';
import { FOLD_VERSION } from '#lib/server/pipeline/fold.js';
import { IDENTITY_VERSION } from '#lib/server/pipeline/identity.js';
import { INDEX_VERSION } from '#lib/server/pipeline/repository.js';
import { newRunId } from '#lib/server/pipeline/runs.js';
import { VIEWER_VERSION } from '#lib/server/pipeline/viewer-files.js';
import { parseStages } from '#lib/render-stages.js';
import { rendersDir } from '#lib/server/renders-dir.js';
import { LIVE_SYNC_WHERE, liveSyncParams, readMeta, writeMeta } from '#lib/server/sync.js';
import { PROCESSING_ATTEMPTS } from '#lib/server/uploads/uploads.js';
import {
	detail,
	estimateRender,
	freshSteps,
	parseSettings,
	parseSyncRun,
	renderSettingArgs,
	withoutRetry,
	sourceDigest,
	sourceMoved,
	GROUP,
	ROW,
	type DetailGroup,
	type SourcePlan,
	type SourceRun,
	type SyncFigures,
	type SyncPlan,
	type SyncRun,
	type SyncRunRow
} from '#lib/sync.js';
import { STAGES, type Stage } from './backfill/stage';
import { defaultAssets } from './render/assets-dir';
import { favoritesCacheFile, rankFavorites, readFavorites } from './render/favorites';
import type { AuthorsResult } from './authors';
import type { RecordsResult } from './records';
import { recordsDir } from './records/store';
import { scanStorePrints, STORE_SCOPE_CACHE } from './render/store-scope';
import { cloneSource } from './render/source';
import { confirmProd, fail, n } from './stage-command';
import { localDbFile, openLocalDb } from './sync/local-db';
import { MIRROR_SITE, mirrorSource, type SourceAdapter } from './sync/mirror';
import { failureLine, lastJsonLine, lastLine, lineMatching } from './sync/output';
import { failedPlan, plansAfterFetch, resolveAccept } from './sync/plan';
import { UPLOADS_SOURCE, uploadsSource } from './sync/uploads';
import { codexSite } from './sync/codex';
import { fprintsSite } from './sync/fprints';
import { polledFetchDetails, polledIngestDetails, polledSource, type PolledSite } from './sync/polled';
import type { PolledAdmitResult } from './polled';
import type { UploadRunResult } from './screenshots/run';
import type { FromUploadsResult } from './screenshots/uploads';
import type { FromSitesResult } from './screenshots/sites';
import { screenshotBucketDetails } from './sync/screenshot-details';
import {
	authorsDetails,
	recordStoreFetch,
	removalsDetails,
	removalsSummary,
	renderStageDetails,
	type RenderRowCounts
} from './sync/step-details';
import type { RemovalsResult } from './removals';
import {
	backfillComplete,
	polledAdmitStatus,
	backfillSummary,
	claimRun,
	ingestKey,
	lastIngestKey,
	outcomeOf,
	SyncRunner,
	type BackfillResult,
	type Outcome,
	type ScriptResult,
	type StepDef
} from './sync/runner';

const USAGE =
	'usage: bun run sync [--stage prod|local] [--yes] | --plan [--json] | --accept <commit|site|site:id> | --figures [--stage S] [--json] | --top-preview N';
const ROOT = join(import.meta.dirname, '..');

const { values: flags } = (() => {
	try {
		return parseArgs({
			options: {
				stage: { type: 'string', default: 'prod' },
				plan: { type: 'boolean', default: false },
				accept: { type: 'string' },
				figures: { type: 'boolean', default: false },
				'top-preview': { type: 'string' },
				json: { type: 'boolean', default: false },
				yes: { type: 'boolean', default: false },
				help: { type: 'boolean', short: 'h', default: false }
			},
			strict: true
		});
	} catch (e) {
		return fail(`${e instanceof Error ? e.message : e}\n${USAGE}`);
	}
})();
if (flags.help) {
	console.log(USAGE);
	process.exit(0);
}
const stage = flags.stage as Stage;
if (!STAGES.includes(stage)) fail(`--stage must be one of ${STAGES.join(', ')}\n${USAGE}`);
if ([flags.plan, flags.figures, flags.accept !== undefined, flags['top-preview'] !== undefined].filter(Boolean).length > 1)
	fail(`pick one of --plan, --accept, --figures and --top-preview\n${USAGE}`);

const clone = process.env.RENDER_CLONE_DIR || join(homedir(), 'data', 'factorio-mirror');
const dbFile = localDbFile(ROOT) ?? fail('no local D1 database: run `bun run db:migrate`');
const local = openLocalDb(dbFile);
const db = local.db;
await db
	.prepare('SELECT sources FROM sync_runs LIMIT 0')
	.all()
	.catch(() => fail('the local D1 database has no sync tables (or an old draft of them): run `bun run db:migrate` (migration 0020)'));
const settings = parseSettings((await readMeta<unknown>(db, 'settings'))?.value, { ramMb: totalmem() / 1048576 }).settings;

if (!existsSync(clone)) fail(`no mirror clone at ${clone} (set RENDER_CLONE_DIR)`);

/** The record store: every other site's records on this machine (scripts/records/store.ts), filled in the fetch step. */
const records = recordsDir(ROOT);

/** Where in-process work (the polled sites' fetch) logs, and whether the update was asked to stop: the runner's, once it runs. */
let say = (line: string) => console.error(line);
let stopRequested = () => false;

/** Polled sites (scripts/sync/polled.ts), one per POLLED_SITES entry. */
const POLLED: PolledSite[] = [codexSite, fprintsSite];
const POLLED_SITE_IDS = POLLED.map((p) => p.site);
const polledSettings = (site: string) => settings.polled[site as keyof typeof settings.polled];

/**
 * The print sources an update fetches, in order. Uploads admit their waiting records in their own fetch
 * (scripts/sync/uploads.ts); polled sites' records are admitted in the ingest step.
 */
const SOURCES: SourceAdapter[] = [
	mirrorSource(clone),
	uploadsSource(ROOT, stage),
	...POLLED.map((site) =>
		polledSource(site, {
			recordsDir: records,
			settings: () => ({ on: polledSettings(site.site).on }),
			log: (line) => say(line),
			stopping: () => stopRequested()
		})
	)
];

/**
 * The record store's prints with a 2.0+ page and their stamps (sync_meta 'store-prints'), so the Update tab's
 * estimate counts those waiting to render (src/lib/server/admin/sync.ts). Never fails the caller.
 */
const saveStorePrints = async () => {
	try {
		const { decoded, ...prints } = await scanStorePrints(records, join(ROOT, '.cache', 'render', STORE_SCOPE_CACHE));
		await writeMeta(db, 'store-prints', prints);
		return { ...prints, decoded };
	} catch (e) {
		console.error(`store prints: ${e instanceof Error ? e.message : String(e)}`);
		return null;
	}
};

/**
 * Where the steps read print records: the mirror clone, and with `store` the record store too (the
 * render steps: uploads and other sites' prints are drawn like the mirror's prints). The backfill and
 * screenshots read the mirror alone: uploads are ingested by the Worker (or the uploads source), and
 * their screenshots come from the stage. Moving a step to the store changes only this.
 */
const recordSourceArgs = (o: { store?: boolean } = {}) => ['--from-clone', clone, ...(o.store ? ['--records', records] : [])];

const short = (id: string | null | undefined) => id?.slice(0, 7) ?? '?';

const describeSource = (p: SourcePlan) =>
	p.error
		? `${p.site}: couldn't check: ${p.error}`
		: p.position
			? `${p.site}: ${p.position}`
			: !sourceMoved(p)
				? `${p.site}: at its latest (${short(p.to.id)})`
				: `${p.site}: ${short(p.from.id)} → ${short(p.to.id)}: +${n(p.added)} new, ${n(p.edited)} edited, ` +
					`${n(p.favourites)} only favourite counts, ${n(p.deleted.length)} deleted; ${n(p.modern)} of the new and edited have a 2.0+ page` +
					(p.blocked ? `\n✗ held back: ${p.blocked}` : '');

/** Turns the saved "retry failed pages" setting off (read again: only that field changes). */
const clearRetryFailed = async () => {
	const off = withoutRetry((await readMeta<unknown>(db, 'settings'))?.value);
	if (off) await writeMeta(db, 'settings', off);
};
const acceptedIds = async () => (await readMeta<Record<string, string>>(db, 'accept'))?.value ?? {};

/**
 * Each source's plan, without fetching anything. One that can't be checked (the stage unreachable) is shown as
 * such; the rest still are. While an update is live, one that started meanwhile too, it stops before the next
 * source and saves nothing: the update asks the sites itself, and each process paces only its own requests.
 */
const planAll = async (signal?: AbortSignal) => {
	const accepted = await acceptedIds();
	const sources: SourcePlan[] = [];
	for (const s of SOURCES) {
		const live = await liveUpdate();
		if (live) fail(`an update is running (${live.id}): its fetch step checks the sources itself`);
		try {
			sources.push(await s.plan({ maxChange: settings.maxChange, accept: accepted[s.site], signal }));
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e);
			console.error(`✗ ${s.site}: ${error}`);
			sources.push(failedPlan(s, error));
		}
	}
	return { checkedAt: Date.now(), sources } satisfies SyncPlan;
};

/** A live update's row, if one is writing it now. */
const liveUpdate = () =>
	db
		.prepare(`SELECT id FROM sync_runs WHERE ${LIVE_SYNC_WHERE} LIMIT 1`)
		.bind(...liveSyncParams())
		.first<{ id: string }>();

// --- one-off modes

if (flags.plan) {
	// The update fetches the clone itself (two fetches at once can fail on git's ref locks) and asks the sites
	// itself: planAll refuses while one is live.
	const plan = await planAll();
	await writeMeta(db, 'plan', plan);
	await saveStorePrints();
	console.log(flags.json ? JSON.stringify(plan) : plan.sources.map(describeSource).join('\n'));
	local.close();
	process.exit(0);
}

if (flags.accept !== undefined) {
	const resolved = resolveAccept(flags.accept, (await readMeta<SyncPlan>(db, 'plan'))?.value.sources ?? [], MIRROR_SITE);
	const got = 'error' in resolved ? fail(resolved.error) : resolved;
	await writeMeta(db, 'accept', { ...(await acceptedIds()), [got.site]: got.id });
	console.log(`accepted ${got.site} ${got.site === MIRROR_SITE ? short(got.id) : got.id}: the next update fetches it`);
	local.close();
	process.exit(0);
}

const figuresText = (f: SyncFigures) =>
	`${f.stage}: ${n(f.prints)} prints, ${n(f.failed)} failed to read, ${n(f.rendered)} rendered, ${n(f.unnamed)} factorioprints prints without an author name`;

if (flags.figures) {
	const { readFigures } = await import('./sync/figures');
	const figures = await readFigures(stage);
	await writeMeta(db, 'figures', figures);
	console.log(flags.json ? JSON.stringify(figures) : figuresText(figures));
	local.close();
	process.exit(0);
}

if (flags['top-preview'] !== undefined) {
	const top = Number(flags['top-preview']);
	if (!Number.isInteger(top) || top < 0 || top > 100_000) fail('--top-preview needs a whole number from 0 to 100000');
	console.log(JSON.stringify(await topPreview(top)));
	local.close();
	process.exit(0);
}

/**
 * What the top `n` would add to the render scope: ranked from the clone's favourite counts (cached,
 * ≈ 1 s), less the prints already in scope (2.0+, or ever in a top list: they keep their renders).
 */
async function topPreview(top: number) {
	const source = cloneSource(resolve(clone));
	const ids = await source.ids();
	const { counts } = await readFavorites(ids, (id) => source.file(id), favoritesCacheFile(join(ROOT, '.cache', 'render'), resolve(clone)));
	const ranked = rankFavorites(counts).slice(0, top);
	const inScope = new Set(
		(
			await db
				.prepare('SELECT print_id FROM render_prints WHERE modern = 1 UNION SELECT print_id FROM render_favorites')
				.all<{ print_id: string }>()
		).results.map((r) => r.print_id)
	);
	const adds = ranked.filter((r) => !inScope.has(r.print_id)).length;
	return { n: top, cutoff: ranked.at(-1)?.favorites ?? 0, adds, estimate: estimateRender(adds) };
}

// --- an update

const assets = process.env.FPSR_ASSETS_DIR || defaultAssets();
const assetsDir =
	assets && existsSync(join(assets, 'manifest.json'))
		? assets
		: fail('no sprite assets: set FPSR_ASSETS_DIR (a folder with manifest.json)');
if (stage === 'prod' && !(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY))
	fail('uploading renders to prod needs R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (docs/deploy.md, "Uploading renders")');
await confirmProd(stage, flags.yes, 'Update PROD from the print sources?').catch((e: unknown) =>
	fail(`✗ ${e instanceof Error ? e.message : e}`)
);

const logDir = join(rendersDir(ROOT), 'logs');
const started = new Date();
const logName = `sync-${started.toISOString().replace(/[:.]/g, '-')}.log`;
const run: SyncRun = {
	id: newRunId(started),
	state: 'running',
	control: null,
	stage,
	options: { settings, pid: process.pid, log: logName },
	sources: [],
	steps: freshSteps(),
	started_at: started.getTime(),
	updated_at: started.getTime(),
	finished_at: null,
	error: null
};
const refusal = claimRun(local.sqlite, run);
if (refusal) fail(refusal);

mkdirSync(logDir, { recursive: true });
const runner = new SyncRunner({ db, run, logFile: join(logDir, logName), cwd: ROOT, echo: true });
say = (line) => runner.say(line);
stopRequested = runner.stopping;
await runner.start();
runner.say(`sync ${run.id} → ${stage} · log ${join(logDir, logName)}`);
const script = (args: string[], env?: Record<string, string>) => runner.runScript(args, env);
const hasSource = (site: string) => run.sources.some((s) => s.site === site);
/** A failed command's outcome, summarised by its last result line. */
const failed = (r: ScriptResult) => outcomeOf(r, '', [], `exit ${r.code}: ${failureLine(r.tail)}`);

/** The ingest step's first part: the backfill over the mirror clone, skipped when nothing it reads changed. */
const backfillStep = async (): Promise<Outcome> => {
	// The backfill's sources only (sourceDigest leaves out uploads, admitted in the fetch), and a hand-over
	// that had to purge a print another source still has (`ingest_due`): the backfill admits it again.
	const key = ingestKey(
		sourceDigest(run.sources),
		{
			analyzer: ANALYZER_VERSION,
			index: INDEX_VERSION,
			viewer: VIEWER_VERSION,
			identity: IDENTITY_VERSION,
			// A new fold rule: the backfill refolds every group (fold.ts isFoldDirty).
			fold: FOLD_VERSION
		},
		run.sources.find((s) => s.ingestDue)?.ingestDue ?? null
	);
	const recent = await db
		.prepare('SELECT * FROM sync_runs WHERE stage = ? AND id != ? ORDER BY started_at DESC LIMIT 50')
		.bind(stage, run.id)
		.all<SyncRunRow>();
	if (lastIngestKey(recent.results.map(parseSyncRun)) === key) {
		// Still current: kept on this run too, as the ingest step may end 'done' from the polled sites' admission.
		run.options.ingestKey = key;
		return {
			status: 'skipped',
			summary: `nothing changed since the last update that ran it (${sourceDigest(run.sources).replace(/@(\w{7})\w+/g, '@$1')})`
		};
	}
	const r = await script(['scripts/backfill.ts', '--stage', stage, ...recordSourceArgs(), '--yes', '--json']);
	const result = lastJsonLine<BackfillResult>(r.tail);
	if (r.code !== 0 || !result) return failed(r);
	const summary = backfillSummary(result);
	if (result.state !== 'finished')
		return { status: 'failed', summary: `the backfill ${result.state}: ${summary}`, runId: result.id, code: r.code };
	// Only a backfill with nothing left to retry lets later updates skip this step.
	if (backfillComplete(result)) run.options.ingestKey = key;
	const kinds = Object.entries(result.failures)
		.map(([k, v]) => `${k} ${n(v)}`)
		.join(', ');
	// The backfill reads one source today (recordSourceArgs), so its counts are that source's.
	const details: DetailGroup[] = [
		{
			title:
				run.sources
					.filter((s) => !s.ingestsItself)
					.map((s) => s.site)
					.join(', ') || undefined,
			rows: [
				...detail(ROW.reindexed, result.reindexed),
				...detail('viewer files rebuilt', result.viewer),
				...detail('favourite counts updated', result.favorites),
				...detail(ROW.analysed, result.analysed, { always: true }),
				...detail(ROW.failed, result.failed, { always: true, tone: 'bad' }),
				...Object.entries(result.failures).flatMap(([k, v]) => detail(`${k} failures`, v, { tone: 'bad' })),
				...detail('known failures skipped', result.skipped),
				...detail('unchanged', result.unchanged),
				...detail(ROW.folded, result.folded),
				...detail('copies unfolded', result.unfolded)
			]
		}
	];
	return {
		status: result.failed ? 'warning' : 'done',
		summary: result.failed ? `${summary} (${kinds})` : summary,
		runId: result.id,
		code: r.code,
		details
	};
};

/**
 * The ingest step's second part: each polled site that is on, its inbox admitted through the gate and its
 * deletions as sources gone (`polled --stage S --site X`, which then pulls the site's own prints into the
 * record store when the stage changed, for this update's render step). Merged into the backfill's outcome.
 */
async function admitPolled(backfill: Outcome, stopping: () => boolean): Promise<Outcome> {
	const parts: string[] = [];
	const details: DetailGroup[] = [];
	let worst: 'done' | 'warning' | 'failed' | 'stopped' = 'done';
	const rank = { skipped: 0, done: 1, warning: 2, stopped: 3, failed: 4 } as Record<string, number>;
	for (const site of POLLED) {
		if (!polledSettings(site.site)?.on || stopping()) continue;
		const r = await script(['scripts/polled.ts', '--stage', stage, '--site', site.site, '--dir', records, '--yes', '--json']);
		const result = lastJsonLine<PolledAdmitResult>(r.tail);
		if (result) details.push(...polledIngestDetails(result));
		const line = result?.summary.replace(/^[✓✗]\s*/, '') ?? failureLine(r.tail);
		parts.push(`${site.site}: ${line}`);
		// A few records that failed (a network blip) are retried next update: a warning, so authors and render still run.
		const status = polledAdmitStatus(r.code, result);
		if (rank[status] > rank[worst]) worst = status;
		if (result?.store)
			details.push({
				title: `record store: ${site.site}`,
				rows: [
					...detail('prints of its own', result.store.listed, { always: true }),
					...detail('new', result.store.added),
					...detail('changed', result.store.changed),
					...detail('removed', result.store.removed + result.store.vanished)
				]
			});
	}
	if (!parts.length) return backfill;
	const status = (rank[worst] ?? 0) > (rank[backfill.status] ?? 0) ? worst : backfill.status === 'skipped' ? worst : backfill.status;
	return {
		...backfill,
		status,
		summary: [backfill.status === 'skipped' ? `backfill skipped: ${backfill.summary}` : backfill.summary, ...parts]
			.filter(Boolean)
			.join(' · '),
		details: [...(backfill.details ?? []), ...details]
	};
}

const steps: StepDef[] = [
	{
		id: 'removals',
		async run(): Promise<Outcome> {
			const r = await script(['scripts/removals.ts', '--stage', stage, '--yes', '--json']);
			const result = lastJsonLine<RemovalsResult>(r.tail);
			const details: DetailGroup[] | undefined = result === null ? undefined : removalsDetails(result);
			if (r.code === 0 && result?.ok) return { status: 'done', summary: removalsSummary(result), code: r.code, details };
			if (result?.stopped) return { status: 'stopped', summary: result.summary.replace(/^[✓✗]\s*/, ''), code: r.code };
			// Prod refuses removed prints itself (ingest checks its blocks), but this machine's copies
			// weren't swept: the steps that could upload them again don't run.
			return {
				status: 'failed',
				summary:
					`REMOVALS NOT APPLIED (exit ${r.code}): ${result?.summary.replace(/^[✓✗]\s*/, '') ?? lastLine(r.tail)}; ` +
					'screenshots and render are skipped until it succeeds',
				code: r.code,
				details
			};
		}
	},
	{
		id: 'fetch',
		async run({ signal, stopping }): Promise<Outcome> {
			const accepted = await acceptedIds();
			const plans: SourcePlan[] = [];
			const errors: string[] = [];
			for (const source of SOURCES) {
				try {
					plans.push(await source.plan({ maxChange: settings.maxChange, accept: accepted[source.site], signal }));
				} catch (e) {
					const error = e instanceof Error ? e.message : String(e);
					errors.push(`${source.site}: ${error}`);
					// Kept in the saved plan with its error, so the Overview never calls it up to date.
					plans.push(failedPlan(source, error));
					run.sources.push({
						site: source.site,
						from: null,
						to: null,
						...(source.ingestsItself ? { ingestsItself: true } : {}),
						...(source.polled ? { polled: true } : {})
					});
				}
			}
			await writeMeta(db, 'plan', { checkedAt: Date.now(), sources: plans } satisfies SyncPlan);
			const parts: string[] = [];
			for (const plan of plans) {
				if (plan.error) continue;
				const entry: SourceRun = {
					site: plan.site,
					from: plan.from,
					to: plan.from,
					...(plan.ingestsItself ? { ingestsItself: true } : {}),
					...(plan.polled ? { polled: true } : {}),
					...(plan.ingestDue ? { ingestDue: plan.ingestDue } : {})
				};
				run.sources.push(entry);
				if (plan.blocked) {
					entry.blocked = plan.blocked;
					parts.push(`${plan.site} held back: ${plan.blocked}`);
				} else if (sourceMoved(plan) && !stopping()) {
					const { counts, ...to } = await SOURCES.find((s) => s.site === plan.site)!.apply(plan, signal);
					entry.to = to;
					entry.deleted = plan.deleted;
					if (counts) {
						entry.counts = counts;
						parts.push(
							`${plan.site}: ${Object.entries(counts)
								.map(([k, v]) => `${n(v)} ${k}`)
								.join(', ')}`
						);
					} else
						parts.push(
							`${plan.site} ${short(plan.from.id)} → ${short(entry.to.id)}: +${n(plan.added)} new, ${n(plan.edited)} edited, ` +
								`${n(plan.favourites)} favourite counts, ${n(plan.deleted.length)} deleted (kept on the site)`
						);
				} else if (plan.off) parts.push(`${plan.site}: off in the settings`);
				else if (!sourceMoved(plan))
					parts.push(`${plan.site}: ${plan.polled ? 'nothing new' : `already at its latest (${short(plan.to.id)})`}`);
			}
			// Then the record store, after the sources have admitted their waiting records (uploads): the render
			// step reads it. Read-only on the stage.
			let store: RecordsResult | null = null;
			if (!stopping()) {
				const r = await script(['scripts/records.ts', '--stage', stage, '--dir', records, '--json']);
				store = lastJsonLine<RecordsResult>(r.tail);
				if (r.code === 0 && store?.ok) parts.push(`record store: ${recordStoreFetch(store, POLLED_SITE_IDS).line}`);
				else errors.push(`record store: ${store?.summary.replace(/^[✓✗]\s*/, '') ?? failureLine(r.tail)}`);
			}
			// The Overview compares each plan's two cursors: after the fetch, the fetched ones are level.
			await writeMeta(db, 'plan', {
				checkedAt: Date.now(),
				sources: plansAfterFetch(
					plans,
					run.sources,
					(site) => (SOURCES.find((s) => s.site === site) as { lastApply?: string } | undefined)?.lastApply
				)
			} satisfies SyncPlan);
			// What the record store now holds for the render step, for the Update tab's estimate.
			if (store?.ok) await saveStorePrints();
			const summary = [...parts, ...errors].join(' · ');
			const details: DetailGroup[] = plans
				.filter((p) => !p.error)
				.map((p) => {
					const entry = run.sources.find((s) => s.site === p.site);
					const to = entry?.to;
					if (p.polled) return polledFetchDetails(p, entry?.counts);
					// A source that admits its own records (uploads, scripts/sync/uploads.ts) says how they came out.
					if (p.site === UPLOADS_SOURCE) {
						const c = entry?.counts ?? {};
						return {
							title: p.site,
							rows: [
								...detail(ROW.waiting, p.added, { always: true }),
								...detail(
									ROW.oldestWaiting,
									p.added ? new Date(p.to.date).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : null
								),
								...detail('admitted', c.admitted),
								...detail('refused as duplicates', c.duplicate),
								...detail('blocked', c.blocked, { tone: 'warn' }),
								...detail('unreadable', c.unreadable, { tone: 'warn' }),
								...detail(ROW.failedRetried, c.failed ?? 0, { always: true, tone: 'bad' }),
								...detail(`gave up (${PROCESSING_ATTEMPTS} tries)`, c['gave up'], { tone: 'bad' }),
								...detail(ROW.stillProcessing, c.left ?? p.added, { always: true }),
								...detail('new names put on uploads', c.renamed),
								...detail('names still to put on uploads', c['names left'], { tone: 'warn' }),
								...detail('accounts being deleted', c.deleting, { tone: 'warn' })
							]
						};
					}
					return {
						title: p.site,
						rows: [
							{ label: ROW.position, value: to && to.id !== p.from.id ? `${short(p.from.id)} → ${short(to.id)}` : short(p.from.id) },
							...detail('held back', p.blocked, { tone: 'warn' }),
							...detail('commits fetched', p.blocked ? 0 : p.behind),
							...detail('new prints', p.added, { always: !p.blocked }),
							...detail('edited', p.edited),
							...detail('only favourite counts', p.favourites),
							...detail('deleted (kept on the site)', p.deleted.length),
							...detail('with a 2.0+ page', p.modern)
						]
					};
				});
			if (store) details.push(recordStoreFetch(store, POLLED_SITE_IDS).group);
			for (const e of errors) details.push({ rows: [{ label: 'failed', value: e, tone: 'bad' }] });
			return { status: errors.length ? 'failed' : plans.some((p) => p.blocked) ? 'warning' : 'done', summary, details };
		}
	},
	{
		id: 'ingest',
		async run({ stopping }): Promise<Outcome> {
			return admitPolled(await backfillStep(), stopping);
		}
	},
	{
		id: 'authors',
		needs: ['ingest'],
		gate: () => (!settings.authors ? 'turned off in the settings' : !hasSource(MIRROR_SITE) ? 'factorioprints prints only' : null),
		async run(): Promise<Outcome> {
			const r = await script(['scripts/authors.ts', '--stage', stage, '--yes', '--json']);
			if (r.code !== 0) return failed(r);
			const a = lastJsonLine<AuthorsResult>(r.tail);
			if (!a) return outcomeOf(r, lastLine(r.tail));
			return {
				...outcomeOf(
					r,
					`${n(a.named)} authors named, ${n(a.prints)} prints given a name${a.left ? `; ${n(a.left)} authors still to ask` : ''}`
				),
				details: authorsDetails(a)
			};
		}
	},
	{
		id: 'screenshots',
		needs: ['removals'],
		gate: () => (settings.screenshots ? null : 'turned off in the settings'),
		async run({ stopping }): Promise<Outcome> {
			const parts: string[] = [];
			let warning = false;
			// Exit 2: Imgur refused us or sent something odd; what was copied still goes up.
			const fetched = await script(['scripts/screenshots.ts', ...recordSourceArgs(), '--json']);
			if (fetched.code !== 0 && fetched.code !== 2) return failed(fetched);
			const copy = lastJsonLine<{
				alreadyCopied: number;
				dead: number;
				toFetch: number;
				fetched: number;
				newlyDead: number;
				failed: number;
				dir: string;
			}>(fetched.tail);
			const details: DetailGroup[] = [];
			if (copy)
				details.push({
					title: GROUP.onThisMachine,
					rows: [
						...detail(ROW.alreadyCopied, copy.alreadyCopied, { always: true }),
						...detail(ROW.deadOnImgur, copy.dead, { always: true }),
						...detail(ROW.toFetch, copy.toFetch, { always: true }),
						...detail(ROW.fetched, copy.fetched),
						...detail(ROW.newlyDead, copy.newlyDead, { tone: 'warn' }),
						...detail(ROW.failed, copy.failed, { always: copy.toFetch > 0, tone: 'bad' }),
						...detail('folder', copy.dir, { muted: true })
					]
				});
			warning ||= fetched.code === 2;
			// `screenshots: done in 26s: fetched 89 (109.0 MB), dead 0, failed 0, …`, or with nothing to
			// fetch its plan line, `screenshots: 18111 already copied, 2 dead; to fetch 0 (…) → <dir>`.
			parts.push(
				lineMatching(fetched.tail, /^screenshots: (done in |\d+ already copied)/)
					.replace(/^screenshots: /, '')
					.replace(/ → .*$/, '')
			);
			if (stopping()) return { status: 'stopped', summary: parts.join(' · '), details };
			// Approved upload screenshots, copied from the stage's private RAW: an input beside Imgur. A failure here
			// still lets Imgur's go up.
			const fromUploads = await script(['scripts/screenshots.ts', '--from-uploads', stage, '--json']);
			const uploaded = lastJsonLine<FromUploadsResult>(fromUploads.tail);
			if (fromUploads.code !== 0) {
				warning = true;
				if (!uploaded) parts.push(`uploads: ${failureLine(fromUploads.tail)}`);
			}
			if (uploaded?.approved || uploaded?.failed)
				parts.push(
					`uploads: ${n(uploaded.approved)} approved, copied ${n(uploaded.fetched)}${uploaded.failed ? `, failed ${n(uploaded.failed)}` : ''}`
				);
			if (stopping()) return { status: 'stopped', summary: parts.join(' · '), details };
			// Images other sites' records name (codex's), for the stage's prints that show them: copied from their
			// URLs (scripts/screenshots/sites.ts), never hotlinked. A failure here still lets the rest go up.
			const fromSites = await script(['scripts/screenshots.ts', '--from-sites', stage, '--json']);
			const sites = lastJsonLine<FromSitesResult>(fromSites.tail);
			if (fromSites.code !== 0) {
				warning = true;
				if (!sites) parts.push(`other sites: ${failureLine(fromSites.tail)}`);
			}
			if (sites?.toFetch || sites?.failed)
				parts.push(
					`other sites: ${n(sites.toFetch)} to copy, copied ${n(sites.fetched)}` +
						(sites.newlyDead ? `, ${n(sites.newlyDead)} gone at the source` : '') +
						(sites.failed ? `, failed ${n(sites.failed)}` : '')
				);
			// Each site's own group, for the Update tab's per-source Screenshots cells.
			for (const [site, c] of Object.entries(sites?.bySite ?? {}))
				details.push({
					title: GROUP.siteShots(site),
					rows: [
						...detail(ROW.imagesShown, c.shown, { always: true }),
						...detail(ROW.alreadyCopied, c.alreadyCopied),
						...detail(ROW.copiedNow, c.fetched),
						...detail(ROW.goneAtSource, c.dead + c.newlyDead, { tone: 'warn' }),
						...detail(ROW.maybeDead, c.maybeDead),
						...detail('removed', c.removed),
						...detail(ROW.failedRetried, c.failed, { tone: 'bad' })
					]
				});
			if (stopping()) return { status: 'stopped', summary: parts.join(' · '), details };
			const up = await script(['scripts/screenshots.ts', '--upload', stage, '--json']);
			if (up.code !== 0) return { ...failed(up), details };
			details.push(...screenshotBucketDetails(stage, uploaded, lastJsonLine<UploadRunResult>(up.tail)));
			// `screenshots: local bucket: 18120 images in 830s: made 89, put 122048 files (…), …`
			parts.push(
				lineMatching(up.tail, /^screenshots: \S+ bucket: /)
					.replace(/^screenshots: /, '')
					.replace(/\. Then: .*$/, '')
			);
			const flagged = await script(['scripts/screenshots-flags.ts', '--stage', stage, '--yes']);
			if (flagged.code !== 0) return { ...failed(flagged), details };
			parts.push(lastLine(flagged.tail));
			// `✓ 89 D1 rows written; cached pages purged`, or `already in sync; nothing written`.
			const written = Number(/([\d,]+) D1 rows written/.exec(flagged.tail)?.[1]?.replace(/,/g, '') ?? 0);
			details.push({ title: GROUP.searchCards, rows: [{ label: 'rows written', value: written }] });
			return { status: warning ? 'warning' : 'done', summary: parts.filter(Boolean).join(' · '), details };
		}
	},
	{
		id: 'render',
		needs: ['ingest', 'removals'],
		gate: () => (settings.render ? null : 'turned off in the settings'),
		async run({ stopping }): Promise<Outcome> {
			const parts: string[] = [];
			const details: DetailGroup[] = [];
			// The top N favourites come from factorioprints' counts.
			const top = hasSource(MIRROR_SITE) ? settings.top : 0;
			if (top > 0) {
				const inTop = async () =>
					(await db.prepare('SELECT print_id FROM render_favorites WHERE in_top = 1').all<{ print_id: string }>()).results.map(
						(r) => r.print_id
					);
				const before = new Set(await inTop());
				const r = await script(['scripts/render-scope.ts', 'top', String(top), ...recordSourceArgs(), '--json']);
				const list = lastJsonLine<{ n: number; cutoff: number }>(r.tail);
				if (r.code !== 0 || !list) return failed(r);
				const after = await inTop();
				const joined = after.filter((id) => !before.has(id)).length;
				const left = before.size - (after.length - joined);
				parts.push(`top ${n(list.n)} (≥ ${n(list.cutoff)} favourites): ${n(joined)} joined, ${n(left)} left`);
				details.push({
					title: `Top ${n(list.n)} favourites (≥ ${n(list.cutoff)})`,
					rows: [
						{ label: 'joined', value: joined },
						{ label: 'left (their renders stay)', value: left }
					]
				});
			}
			const r = await script(['scripts/render-scope.ts', 'check', ...recordSourceArgs({ store: true }), '--json']);
			const check = lastJsonLine<{ changed: number; gone: number }>(r.tail);
			if (r.code !== 0 || !check) return failed(r);
			parts.push(`${n(check.changed)} rendered prints changed, ${n(check.gone)} gone from their source (renders kept)`);
			details.push({
				title: 'Rendered prints',
				rows: [
					{ label: 'record changed', value: check.changed },
					{ label: 'gone from their source (renders kept)', value: check.gone }
				]
			});
			if (stopping()) return { status: 'stopped', summary: parts.join(' · '), details };

			const args = ['scripts/render-game.ts', ...recordSourceArgs({ store: true }), '--next', String(settings.perUpdate ?? 100_000)];
			if (top > 0) args.push('--top', String(top));
			args.push('--upload', stage, '--flags');
			args.push(...renderSettingArgs(settings));
			const since = Date.now();
			const rendered = await script(args, { FPSR_ASSETS_DIR: assetsDir });
			// "Retry failed pages" is for one update: cleared once the render step has drawn. A step that stopped before
			// drawing (its top list or check failed) leaves it on, for the next update.
			if (settings.retryFailed) await clearRetryFailed();
			const row = await db
				.prepare(
					`SELECT id, json_extract(options, '$.stages') AS stages, prints_total, prints_rendered, rendered, failed, uploaded, uploads_pending
					FROM render_runs WHERE started_at >= ? ORDER BY started_at DESC LIMIT 1`
				)
				.bind(since - 1000)
				.first<RenderRowCounts & { id: string; stages: string | null }>();
			// The run's stages per source as it ended: the Update tab's board reads them from the step.
			const stages = row ? parseStages(row.stages) : null;
			parts.push(
				row
					? row.prints_total === 0
						? 'nothing to render or upload'
						: `${n(row.prints_total)} prints: ${n(row.rendered)} pages drawn (in ${n(row.prints_rendered)} prints), ${n(row.uploaded)} uploaded, ` +
							`${n(row.failed)} failed` +
							(row.uploads_pending ? `, ${n(row.uploads_pending)} uploads left for the next update` : '')
					: lastLine(rendered.tail)
			);
			if (row) details.push(...renderStageDetails(row, stages));
			// 2: pages failed; 3: uploads left for the next update; 4: the search flags step failed (run it by hand).
			if (rendered.code === 4) parts.push('render:flags failed: run it by hand');
			return {
				...outcomeOf(rendered, parts.join(' · '), [2, 3, 4], `exit ${rendered.code}: ${lastLine(rendered.tail)}`),
				runId: row?.id,
				details,
				...(stages ? { render: stages } : {})
			};
		}
	},
	{
		id: 'figures',
		async run(): Promise<Outcome> {
			const r = await script(['scripts/sync.ts', '--figures', '--stage', stage, '--json']);
			const figures = lastJsonLine<SyncFigures>(r.tail);
			if (r.code !== 0 || !figures) return failed(r);
			const details: DetailGroup[] = [
				{
					title: figures.stage,
					rows: [
						{ label: 'prints', value: figures.prints },
						{ label: 'failed to read', value: figures.failed },
						{ label: 'with a render', value: figures.rendered },
						{ label: 'factorioprints prints without an author name', value: figures.unnamed }
					]
				},
				...(figures.bySource
					? [
							{
								title: 'prints by source',
								rows: Object.entries(figures.bySource)
									.sort(([, x], [, y]) => y.prints - x.prints)
									.map(([site, c]) => ({ label: site, value: c.prints }))
							}
						]
					: [])
			];
			return { status: 'done', summary: figuresText(figures), details };
		}
	}
];

await runner.runSteps(steps);
const done = await runner.finish();
local.close();
process.exit(done.state === 'finished' && !done.steps.some((s) => s.status === 'failed') ? 0 : 1);
