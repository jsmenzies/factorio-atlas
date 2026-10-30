/**
 * `bun run sync`: one update. Fetch every print source (today the factorioprints mirror clone), then
 * bring the stage up to date with them, using the settings saved from the admin Overview (sync_meta
 * 'settings'; defaults in #lib/sync.js):
 *
 *   1. removals     `removals --stage S --yes --json`: this machine's copies of prints the stage
 *                   deleted (blocks into the local D1, render rows and files, thumbnails, screenshot
 *                   copies). Runs whatever else happens; when it fails, screenshots and render (which
 *                   could put a removed print's files back) are skipped and the update says so
 *   2. fetch        each source: what's new (for the mirror: GitHub's latest commit against the
 *                   clone's), then fetch it (fast-forward). A source is held back, and only it, when
 *                   adds, deletions and moves are more than `maxChange` of its prints (a layout
 *                   change; `--accept <commit>` lets one through), it would have no prints, or its
 *                   history was rewritten
 *   3. ingest       `backfill --stage S --from-clone … --json`; skipped when neither the sources'
 *                   digest nor the analyzer, index or viewer version changed since the last update
 *                   that ran it to the end (a backfill with failures that aren't the records' own
 *                   doesn't count as the end)
 *   4. authors      `authors --stage S --limit <authorLimit>` (Firebase, only authors never asked;
 *                   factorioprints only); needs ingest
 *   5. screenshots  `screenshots` (new ones from Imgur; weekly `--recheck` if set), `--upload S`,
 *                   `screenshots:flags --stage S`; needs removals
 *   6. render       `render:top <top>` (factorioprints only) and `render:check`, then
 *                   `render --next <perUpdate> --top <top> --upload S --flags`; needs ingest and removals
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
 *   bun run sync --accept <commit>              fetch a held-back mirror commit anyway (sync_meta 'accept')
 *   bun run sync --figures [--stage S] [--json] count what the stage has (sync_meta 'figures')
 *   bun run sync --top-preview N                what a top N would add to the render scope (JSON)
 *
 * The stage defaults to prod. The mirror clone is RENDER_CLONE_DIR (default ~/data/factorio-mirror),
 * the sprites FPSR_ASSETS_DIR (default: the newest set in ~/fpsr-assets). Exit 0 when the update
 * finished with no step failed (warnings included), 1 when a step failed or it was stopped, 2 on
 * bad usage or when it refuses to start.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ANALYZER_VERSION } from '#lib/server/pipeline/analyze.js';
import { IDENTITY_VERSION } from '#lib/server/pipeline/identity.js';
import { INDEX_VERSION } from '#lib/server/pipeline/repository.js';
import { newRunId } from '#lib/server/pipeline/runs.js';
import { VIEWER_VERSION } from '#lib/server/pipeline/viewer-files.js';
import { rendersDir } from '#lib/server/renders-dir.js';
import { LIVE_SYNC_WHERE, liveSyncParams, readMeta, writeMeta } from '#lib/server/sync.js';
import {
	estimateRender,
	freshSteps,
	parseSettings,
	parseSyncRun,
	sourceDigest,
	sourceMoved,
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
import { cloneSource } from './render/source';
import { confirmProd, fail, n } from './stage-command';
import { localDbFile, openLocalDb } from './sync/local-db';
import { MIRROR_SITE, mirrorSource, type SourceAdapter } from './sync/mirror';
import { lastJsonLine, lastLine, lineMatching } from './sync/output';
import {
	backfillComplete,
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
	'usage: bun run sync [--stage prod|local] [--yes] | --plan [--json] | --accept <commit> | --figures [--stage S] [--json] | --top-preview N';
const ROOT = join(import.meta.dirname, '..');
const WEEK_MS = 7 * 24 * 3600_000;

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
const settings = parseSettings((await readMeta<unknown>(db, 'settings'))?.value).settings;

if (!existsSync(clone)) fail(`no mirror clone at ${clone} (set RENDER_CLONE_DIR)`);

/** The print sources an update fetches, in order. */
const SOURCES: SourceAdapter[] = [mirrorSource(clone)];

/**
 * Where the steps read print records: today the mirror clone. Moving the steps to another record
 * source (a record store over every site) changes only this.
 */
const recordSourceArgs = () => ['--from-clone', clone];

const short = (id: string | null | undefined) => id?.slice(0, 7) ?? '?';

const describeSource = (p: SourcePlan) =>
	!sourceMoved(p)
		? `${p.site}: at its latest (${short(p.to.id)})`
		: `${p.site}: ${short(p.from.id)} → ${short(p.to.id)}: +${n(p.added)} new, ${n(p.edited)} edited, ` +
			`${n(p.favourites)} only favourite counts, ${n(p.deleted.length)} deleted; ${n(p.modern)} of the new and edited have a 2.0+ page` +
			(p.blocked ? `\n✗ held back: ${p.blocked}` : '');

const acceptedIds = async () => (await readMeta<Record<string, string>>(db, 'accept'))?.value ?? {};

/** Each source's plan, without fetching anything. */
const planAll = async (signal?: AbortSignal) => {
	const accepted = await acceptedIds();
	const sources: SourcePlan[] = [];
	for (const s of SOURCES) sources.push(await s.plan({ maxChange: settings.maxChange, accept: accepted[s.site], signal }));
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
	// The update fetches the clone itself: two fetches at once can fail on git's ref locks.
	const live = await liveUpdate();
	if (live) fail(`an update is running (${live.id}): its fetch step checks the sources itself`);
	const plan = await planAll();
	await writeMeta(db, 'plan', plan);
	console.log(flags.json ? JSON.stringify(plan) : plan.sources.map(describeSource).join('\n'));
	local.close();
	process.exit(0);
}

if (flags.accept !== undefined) {
	const commit = flags.accept.trim();
	if (!/^[0-9a-f]{7,40}$/.test(commit)) fail('--accept takes a mirror commit (its hash)');
	const last = (await readMeta<SyncPlan>(db, 'plan'))?.value.sources.find((p) => p.site === MIRROR_SITE);
	const held =
		last?.blocked && last.to.id.startsWith(commit)
			? last
			: fail(`the last check didn't hold back ${commit}: run \`bun run sync --plan\` and accept the commit it names`);
	await writeMeta(db, 'accept', { ...(await acceptedIds()), [MIRROR_SITE]: held.to.id });
	console.log(`accepted ${MIRROR_SITE} ${short(held.to.id)}: the next update fetches it`);
	local.close();
	process.exit(0);
}

const figuresText = (f: SyncFigures) =>
	`${f.stage}: ${n(f.prints)} prints, ${n(f.failed)} failed to read, ${n(f.rendered)} rendered, ${n(f.unnamed)} without an author name`;

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
await runner.start();
runner.say(`sync ${run.id} → ${stage} · log ${join(logDir, logName)}`);
const script = (args: string[], env?: Record<string, string>) => runner.runScript(args, env);
const hasSource = (site: string) => run.sources.some((s) => s.site === site);
/** A failed command's outcome, summarised by its last result line. */
const failed = (r: ScriptResult) => outcomeOf(r, '', [], `exit ${r.code}: ${lastLine(r.tail)}`);

const steps: StepDef[] = [
	{
		id: 'removals',
		async run(): Promise<Outcome> {
			const r = await script(['scripts/removals.ts', '--stage', stage, '--yes', '--json']);
			const result = lastJsonLine<{ ok: boolean; summary: string; stopped: boolean }>(r.tail);
			if (r.code === 0 && result?.ok) return { status: 'done', summary: result.summary.replace(/^[✓✗]\s*/, ''), code: r.code };
			if (result?.stopped) return { status: 'stopped', summary: result.summary.replace(/^[✓✗]\s*/, ''), code: r.code };
			// Prod refuses removed prints itself (ingest checks its blocks), but this machine's copies
			// weren't swept: the steps that could upload them again don't run.
			return {
				status: 'failed',
				summary:
					`REMOVALS NOT APPLIED (exit ${r.code}): ${result?.summary.replace(/^[✓✗]\s*/, '') ?? lastLine(r.tail)}; ` +
					'screenshots and render are skipped until it succeeds',
				code: r.code
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
					errors.push(`${source.site}: ${e instanceof Error ? e.message : e}`);
					run.sources.push({ site: source.site, from: null, to: null });
				}
			}
			await writeMeta(db, 'plan', { checkedAt: Date.now(), sources: plans } satisfies SyncPlan);
			const parts: string[] = [];
			for (const plan of plans) {
				const entry: SourceRun = { site: plan.site, from: plan.from, to: plan.from };
				run.sources.push(entry);
				if (plan.blocked) {
					entry.blocked = plan.blocked;
					parts.push(`${plan.site} held back: ${plan.blocked}`);
				} else if (sourceMoved(plan) && !stopping()) {
					entry.to = await SOURCES.find((s) => s.site === plan.site)!.apply(plan, signal);
					entry.deleted = plan.deleted;
					parts.push(
						`${plan.site} ${short(plan.from.id)} → ${short(entry.to.id)}: +${n(plan.added)} new, ${n(plan.edited)} edited, ` +
							`${n(plan.favourites)} favourite counts, ${n(plan.deleted.length)} deleted (kept on the site)`
					);
				} else if (!sourceMoved(plan)) parts.push(`${plan.site}: already at its latest (${short(plan.to.id)})`);
			}
			// The Overview compares each plan's two cursors: after the fetch, the fetched ones are level.
			await writeMeta(db, 'plan', {
				checkedAt: Date.now(),
				sources: plans.map((p) => {
					const to = run.sources.find((s) => s.site === p.site)?.to;
					return to && to.id === p.to.id ? { ...p, from: to, added: 0, edited: 0, favourites: 0, deleted: [], modern: 0 } : p;
				})
			} satisfies SyncPlan);
			const summary = [...parts, ...errors].join(' · ');
			return { status: errors.length ? 'failed' : plans.some((p) => p.blocked) ? 'warning' : 'done', summary };
		}
	},
	{
		id: 'ingest',
		async run(): Promise<Outcome> {
			const key = ingestKey(sourceDigest(run.sources), {
				analyzer: ANALYZER_VERSION,
				index: INDEX_VERSION,
				viewer: VIEWER_VERSION,
				identity: IDENTITY_VERSION
			});
			const recent = await db
				.prepare('SELECT * FROM sync_runs WHERE stage = ? AND id != ? ORDER BY started_at DESC LIMIT 50')
				.bind(stage, run.id)
				.all<SyncRunRow>();
			if (lastIngestKey(recent.results.map(parseSyncRun)) === key)
				return {
					status: 'skipped',
					summary: `nothing changed since the last update that ran it (${sourceDigest(run.sources).replace(/@(\w{7})\w+/g, '@$1')})`
				};
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
			return {
				status: result.failed ? 'warning' : 'done',
				summary: result.failed ? `${summary} (${kinds})` : summary,
				runId: result.id,
				code: r.code
			};
		}
	},
	{
		id: 'authors',
		needs: ['ingest'],
		gate: () => (!settings.authors ? 'turned off in the settings' : !hasSource(MIRROR_SITE) ? 'factorioprints prints only' : null),
		async run(): Promise<Outcome> {
			const r = await script(['scripts/authors.ts', '--stage', stage, '--limit', String(settings.authorLimit), '--yes']);
			return r.code === 0 ? outcomeOf(r, lastLine(r.tail)) : failed(r);
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
			const fetched = await script(['scripts/screenshots.ts', ...recordSourceArgs()]);
			if (fetched.code !== 0 && fetched.code !== 2) return failed(fetched);
			warning ||= fetched.code === 2;
			// `screenshots: done in 26s: fetched 89 (109.0 MB), dead 0, failed 0, …`, or with nothing to
			// fetch its plan line, `screenshots: 18111 already copied, 2 dead; to fetch 0 (…) → <dir>`.
			parts.push(
				lineMatching(fetched.tail, /^screenshots: (done in |\d+ already copied)/)
					.replace(/^screenshots: /, '')
					.replace(/ → .*$/, '')
			);
			const rechecked = await readMeta<number>(db, 'imgur-recheck');
			if (!stopping() && settings.imgurRecheck === 'weekly' && Date.now() - (rechecked?.value ?? 0) > WEEK_MS) {
				const r = await script(['scripts/screenshots.ts', '--recheck']);
				if (r.code === 0) await writeMeta(db, 'imgur-recheck', Date.now());
				else warning = true;
				parts.push(lineMatching(r.tail, /^screenshots: /).replace(/^screenshots: /, ''));
			}
			if (stopping()) return { status: 'stopped', summary: parts.join(' · ') };
			const up = await script(['scripts/screenshots.ts', '--upload', stage]);
			if (up.code !== 0) return failed(up);
			// `screenshots: local bucket: 18120 images in 830s: made 89, put 122048 files (…), …`
			parts.push(
				lineMatching(up.tail, /^screenshots: \S+ bucket: /)
					.replace(/^screenshots: /, '')
					.replace(/\. Then: .*$/, '')
			);
			const flagged = await script(['scripts/screenshots-flags.ts', '--stage', stage, '--yes']);
			if (flagged.code !== 0) return failed(flagged);
			parts.push(lastLine(flagged.tail));
			return { status: warning ? 'warning' : 'done', summary: parts.filter(Boolean).join(' · ') };
		}
	},
	{
		id: 'render',
		needs: ['ingest', 'removals'],
		async run({ stopping }): Promise<Outcome> {
			const parts: string[] = [];
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
				parts.push(
					`top ${n(list.n)} (≥ ${n(list.cutoff)} favourites): ${n(joined)} joined, ${n(before.size - (after.length - joined))} left`
				);
			}
			const r = await script(['scripts/render-scope.ts', 'check', ...recordSourceArgs(), '--json']);
			const check = lastJsonLine<{ changed: number; gone: number }>(r.tail);
			if (r.code !== 0 || !check) return failed(r);
			parts.push(`${n(check.changed)} rendered prints changed, ${n(check.gone)} gone from their source (renders kept)`);
			if (stopping()) return { status: 'stopped', summary: parts.join(' · ') };

			const args = ['scripts/render-game.ts', ...recordSourceArgs(), '--next', String(settings.perUpdate ?? 100_000)];
			if (top > 0) args.push('--top', String(top));
			args.push('--upload', stage, '--flags');
			if (settings.workers) args.push('--workers', String(settings.workers));
			const since = Date.now();
			const rendered = await script(args, { FPSR_ASSETS_DIR: assetsDir });
			const row = await db
				.prepare(
					'SELECT id, prints_total, prints_rendered, rendered, failed, uploaded, uploads_pending FROM render_runs WHERE started_at >= ? ORDER BY started_at DESC LIMIT 1'
				)
				.bind(since - 1000)
				.first<{
					id: string;
					prints_total: number;
					prints_rendered: number;
					rendered: number;
					failed: number;
					uploaded: number;
					uploads_pending: number;
				}>();
			parts.push(
				row
					? row.prints_total === 0
						? 'nothing to render or upload'
						: `${n(row.prints_total)} prints: ${n(row.rendered)} pages drawn (in ${n(row.prints_rendered)} prints), ${n(row.uploaded)} uploaded, ` +
							`${n(row.failed)} failed` +
							(row.uploads_pending ? `, ${n(row.uploads_pending)} uploads left for the next update` : '')
					: lastLine(rendered.tail)
			);
			// 2: pages failed; 3: uploads left for the next update; 4: the search flags step failed (run it by hand).
			if (rendered.code === 4) parts.push('render:flags failed: run it by hand');
			return { ...outcomeOf(rendered, parts.join(' · '), [2, 3, 4], `exit ${rendered.code}: ${lastLine(rendered.tail)}`), runId: row?.id };
		}
	},
	{
		id: 'figures',
		async run(): Promise<Outcome> {
			const r = await script(['scripts/sync.ts', '--figures', '--stage', stage, '--json']);
			const figures = lastJsonLine<SyncFigures>(r.tail);
			return r.code === 0 && figures ? { status: 'done', summary: figuresText(figures) } : failed(r);
		}
	}
];

await runner.runSteps(steps);
const done = await runner.finish();
local.close();
process.exit(done.state === 'finished' && !done.steps.some((s) => s.status === 'failed') ? 0 : 1);
