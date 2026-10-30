/**
 * Thumbnails of every rendered page (names, tiers and settings in #lib/viewer/thumbs.ts, image work
 * in scripts/render/thumbs.ts, upload in scripts/render/thumbs-upload.ts). Reads the renders folder
 * (RENDERS_DIR) and never writes to it; writes to the thumbs folder (THUMBS_DIR, else data/thumbs),
 * in the renders bucket's layout.
 *
 *   bun run render:thumbs (--ids a,b | --ids-file f | --all) [--force] [--jobs N]
 *       For each print's rendered pages (its index.json), `<id>/<base>.<stamp>.t<tier>.avif` at
 *       every tier the overview's size allows, and `<id>/thumbs.json`, written as soon as the print's
 *       pages are done. Pages whose thumbnails match their overview's stamp are left alone (--force
 *       makes them again); thumbnails of older stamps and removed pages are deleted.
 *
 *   bun run render:thumbs --upload local|prod (--ids a,b | --ids-file f | --all) [--jobs N] [--flags]
 *       Put the thumbs folder's thumbnails and thumbs.json of those prints (--all: every print in the
 *       thumbs folder) into the stage's RENDERS bucket under the same keys: local = the miniflare
 *       bucket `bun run dev` uses, prod = the deployed one through R2's S3 API (R2_ACCESS_KEY_ID,
 *       R2_SECRET_ACCESS_KEY). What each bucket has is kept in the local D1 (thumb_uploads), so an
 *       unchanged print costs no request; replaced thumbnails are deleted after the renders' grace
 *       period (RENDER_DELETE_GRACE_S). Makes nothing. Then `bun run render:flags --stage …` gives
 *       the stage's search cards their cover thumbnail; `--flags` does that at the end, as
 *       `bun run render --upload … --flags` does (scripts/render/stage-flags.ts), bumping the page
 *       cache when thumbnails were scheduled for deletion. Never fatal: on failure it prints the
 *       command to run by hand (exit 4).
 *
 * Pages run --jobs at a time (default: half the CPUs), each encode on one thread.
 */
import { availableParallelism } from 'node:os';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { rendersDir, thumbsDir } from '#lib/server/renders-dir.js';
import { THUMB, THUMB_TIERS, type ThumbPage } from '#lib/viewer/thumbs.js';
import { ROOT } from './render/settings.js';
import { finishPrint, makePage, mapPool, planPrint, type PageResult } from './render/thumbs.js';

const USAGE =
	'usage: render-thumbs (--ids a,b | --ids-file f | --all) [--force] [--jobs N]\n' +
	'       render-thumbs --upload local|prod (--ids a,b | --ids-file f | --all) [--jobs N] [--flags]';

function fail(problem: string): never {
	console.error(`${problem}\n${USAGE}`);
	process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
	console.log(USAGE);
	process.exit(0);
}
const value = (flag: string) => (argv[0] && !argv[0].startsWith('--') ? argv.shift()! : fail(`${flag} needs a value`));
const readIds = async (file: string) =>
	(await readFile(file, 'utf8'))
		.split(/\s+/)
		.map((s) => s.split('|')[0].trim())
		.filter(Boolean);

let upload: 'local' | 'prod' | null = null;
let withFlags = false;
let all = false;
let force = false;
let ids: string[] | null = null;
let jobs = Math.max(1, Math.floor(availableParallelism() / 2));
while (argv.length) {
	const a = argv.shift()!;
	if (a === '--upload') {
		const t = value(a);
		upload = t === 'local' || t === 'prod' ? t : fail('--upload takes local or prod');
	} else if (a === '--flags') withFlags = true;
	else if (a === '--all') all = true;
	else if (a === '--force') force = true;
	else if (a === '--ids') ids = value(a).split(',').filter(Boolean);
	else if (a === '--ids-file') ids = await readIds(value(a));
	else if (a === '--jobs') jobs = Number(value(a));
	else fail(`unknown argument: ${a}`);
}
if (!Number.isInteger(jobs) || jobs < 1) fail('--jobs needs a whole number above 0');
if (!ids && !all) fail('pick the prints: --ids, --ids-file or --all');
if (ids && all) fail('--all and --ids together');
if (upload && force) fail('--upload only uploads: no --force with it');
if (withFlags && !upload) fail('--flags sets the flags of the stage it uploads to: it needs --upload local|prod');

const RENDERS = rendersDir(ROOT);
const THUMBS = thumbsDir(ROOT);
if (resolve(THUMBS) === resolve(RENDERS) || resolve(THUMBS).startsWith(`${resolve(RENDERS)}/`))
	fail('THUMBS_DIR must not be in the renders folder');
// One thread per encode; pages run side by side instead.
sharp.concurrency(1);
sharp.cache(false);

const subdirs = async (dir: string) =>
	(await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name !== 'logs').map((d) => d.name);
const renderedIds = () => subdirs(RENDERS);

const kb = (bytes: number) => (bytes / 1024).toFixed(1);
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

if (upload) await runUpload(upload);
else await runWrite();

async function runWrite() {
	const started = performance.now();
	const list = ids ?? (await renderedIds());
	const plans = (await mapPool(list, 32, (id) => planPrint(RENDERS, THUMBS, id, force))).filter((p) => p !== null);
	const jobsList = plans.flatMap((p) => p.jobs);
	const keptPages = plans.reduce((s, p) => s + Object.keys(p.kept).length, 0);
	console.log(`${plans.length} of ${list.length} prints have renders: ${jobsList.length} pages to make, ${keptPages} up to date`);
	const enc = THUMB;
	// Each print is finished (thumbs.json written, old files swept) as soon as its last page is made,
	// so a stopped run keeps what it did and the next one skips it.
	const byKey = new Map<string, PageResult>();
	const left = new Map(plans.map((p) => [p.id, p.jobs.length]));
	const planOf = new Map(plans.map((p) => [p.id, p]));
	let removed = 0;
	let failedPages = 0;
	const finish = async (id: string) => {
		const plan = planOf.get(id)!;
		const pages: Record<string, ThumbPage> = { ...plan.kept };
		for (const j of plan.jobs) {
			const r = byKey.get(`${j.id}\n${j.path}`);
			if (r) pages[j.path] = r.page;
		}
		removed += await finishPrint(THUMBS, id, plan.order, pages);
	};
	await mapPool(
		plans.filter((p) => !p.jobs.length),
		32,
		(p) => finish(p.id)
	);
	let done = 0;
	await mapPool(jobsList, jobs, async (job) => {
		try {
			const r = await makePage(RENDERS, THUMBS, job, enc);
			if (r) byKey.set(`${job.id}\n${job.path}`, r);
		} catch (e) {
			failedPages++;
			console.warn(`${job.id} ${job.path || 'root'}: ${e instanceof Error ? e.message : String(e)}`);
		}
		const n = left.get(job.id)! - 1;
		left.set(job.id, n);
		if (n === 0) await finish(job.id);
		if (++done % 500 === 0) console.log(`${done} of ${jobsList.length} pages, ${((performance.now() - started) / 1000).toFixed(0)} s`);
	});
	const wall = performance.now() - started;
	const made = [...byKey.values()];
	console.log(
		`\n${made.length} pages made in ${(wall / 1000).toFixed(1)} s with ${jobs} jobs (AVIF q${enc.quality} effort ${enc.effort}); ` +
			`${jobsList.length - made.length - failedPages} without an overview file, ${failedPages} failed; ${removed} old thumbnails deleted. Into ${THUMBS}`
	);
	if (!made.length) return;
	const ms = made.map((r) => r.ms);
	console.log(`per page: ${mean(ms).toFixed(0)} ms mean, ${Math.max(...ms)} ms max (decode + encodes, one thread)`);
	console.log(
		`tiers: ${THUMB_TIERS.map((t) => `${made.filter((r) => r.page.sizes.includes(t)).length} at ${t}`).join(', ')}; ` +
			`${made.filter((r) => r.clamped).length} pages have their largest tier at the overview's own size (larger tiers skipped)`
	);
	for (const t of THUMB_TIERS) {
		const full = made.filter((r) => r.bytes[t] !== undefined && !(r.clamped && r.page.sizes.at(-1) === t)).map((r) => r.bytes[t]);
		const any = made.filter((r) => r.bytes[t] !== undefined).map((r) => r.bytes[t]);
		if (!any.length) continue;
		console.log(
			`t${t}: ${any.length} files, mean ${kb(mean(any))} KB, max ${kb(Math.max(...any))} KB` +
				(full.length ? ` (full-size ones: ${full.length}, mean ${kb(mean(full))} KB)` : '')
		);
	}
	const totalBytes = made.reduce((s, r) => s + Object.values(r.bytes).reduce((a, b) => a + b, 0), 0);
	const files = made.reduce((s, r) => s + r.page.sizes.length, 0);
	console.log(`total ${(totalBytes / 1024 / 1024).toFixed(1)} MB in ${files} files; ${kb(totalBytes / made.length)} KB per page`);
}

async function runUpload(target: 'local' | 'prod') {
	const { getPlatformProxy } = await import('wrangler');
	const { openStore, deleteGraceMs } = await import('./render/target.js');
	const { thumbUploadDb, uploadThumbs } = await import('./render/thumbs-upload.js');
	const proxy = await getPlatformProxy<Env>({ persist: true });
	let code = 0;
	let thumbDeletes = 0;
	let stage: Awaited<ReturnType<typeof import('./backfill/stage.js').openTarget>> | null = null;
	try {
		// Nor a print the target's stage deleted or blocked, checked again before each print (removed-guard.ts).
		const { removedGuard } = await import('./render/removed-guard.js');
		if (target === 'prod') stage = await (await import('./backfill/stage.js')).openTarget('prod', { log: console.log });
		const guard = await removedGuard((stage?.env ?? proxy.env).DB, console.log);
		// Never a print removed on request (the local copy of `removal_blocks`, from `bun run removals`).
		const { loadRemovedPrintIds } = await import('#lib/server/removal-blocks.js');
		const removed = await loadRemovedPrintIds(proxy.env.DB);
		const wanted = ids ?? (await subdirs(THUMBS));
		const list = wanted.filter((id) => !removed.has(id));
		if (list.length < wanted.length) console.log(`removed on request: ${wanted.length - list.length} prints left out`);
		const graceMs = deleteGraceMs(process.env.RENDER_DELETE_GRACE_S, target);
		const store = (await openStore(target, proxy.env.RENDERS))!;
		const started = performance.now();
		console.log(`uploading the thumbnails of ${list.length} prints from ${THUMBS} to ${store.label}`);
		const stats = await uploadThumbs({
			store,
			db: thumbUploadDb(proxy.env.DB),
			target,
			dir: THUMBS,
			ids: list,
			graceMs,
			concurrency: Math.min(jobs, 16),
			removed: guard.removed
		});
		if (guard.skipped.size) console.log(`not uploaded: ${guard.skipped.size} prints the ${target} stage deleted or removed`);
		console.log(
			`${stats.uploaded} prints uploaded (${stats.files} files, ${(stats.bytes / 1024 / 1024).toFixed(1)} MB), ${stats.unchanged} unchanged, ${stats.missing} without thumbnails; ` +
				`${stats.deletesScheduled} replaced files to delete in ${Math.round(graceMs / 1000)} s, ${stats.deleted} due ones deleted` +
				`${stats.kept ? `, ${stats.kept} kept (wanted again)` : ''}${stats.failed ? `; ${stats.failed} FAILED (run again)` : ''}; ` +
				`${((performance.now() - started) / 1000).toFixed(1)} s`
		);
		if (stats.failed) code = 2;
		thumbDeletes = stats.deletesScheduled;
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		code = 1;
	} finally {
		await stage?.dispose().catch(() => undefined);
		await proxy.dispose();
	}
	if (withFlags && code !== 1) {
		const { needsPageBump, runStageFlags } = await import('./render/stage-flags.js');
		const bump = needsPageBump({ replaced: 0, removed: 0, renderDeletes: 0, thumbDeletes });
		try {
			// `--flags` is the consent: no typed "prod".
			await runStageFlags(target, { confirm: async () => {}, bump, log: (line) => console.log(line) });
		} catch (e) {
			console.log(
				`flags: failed: ${e instanceof Error ? e.message : String(e)}\n` +
					`  the thumbnails are up; run by hand: bun run render:flags --stage ${target}${bump ? ' --bump' : ''}`
			);
			code ||= 4;
		}
	}
	process.exit(code);
}
