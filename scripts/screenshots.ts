/**
 * `bun run screenshots`: copy every print's screenshot, the original file exactly as Imgur serves
 * it, into SCREENSHOTS_DIR (e.g. in .env; default data/screenshots); then make the sizes the site
 * shows, upload them, and keep up with deletions on Imgur.
 *
 *   bun run screenshots [--from-clone DIR] [--from-disk [DIR]] [--ids a,b] [--limit N]
 *                       [--rate N] [--in-flight N] [--recheck-dead] [--plan-only] [--no-canary] [--json]
 *   bun run screenshots --make [--ids a,b] [--limit N] [--jobs N]
 *   bun run screenshots --upload local|prod [--ids a,b] [--limit N] [--jobs N] [--plan-only] [--json]
 *   bun run screenshots --recheck [--ids a,b] [--limit N] [--rate N]
 *
 * The fetch (the default):
 *
 * - Images come from `image.id` in the mirror clone's records (`--from-clone`, default
 *   RENDER_CLONE_DIR or ~/data/factorio-mirror), plus `--from-disk` (default data/raw/factorioprints)
 *   for prints the clone lacks. Never Firebase. One Imgur id used by several prints is fetched once.
 * - `--ids` takes print ids and Imgur ids; `--limit N` fetches the first N images that need it.
 * - At most 4 requests a second and 4 in flight (`--rate`, at most 20, and `--in-flight`, at most 32,
 *   change that), with a descriptive user agent and no Referer.
 * - Each original is checked (ETag = MD5 of the body, Content-Type = the format of the bytes) and
 *   stored under its real format, `originals/<first 2 chars>/<imgur id>.<ext>`, through a temp file
 *   and a rename, then recorded in `state.jsonl` (state.ts).
 * - A redirect to removed.png (or 404/410) records the image dead; it isn't asked again unless
 *   `--recheck-dead`. 5xx, timeouts and network errors are retried (3 tries, backoff), then
 *   recorded failed, and tried again on the next run.
 * - The run stops, exit code 2, on a 429 or 403 (Imgur refusing us), on a web page served in place of
 *   an image, or when the canary (a known image, fetched first and again every 500 stored images)
 *   doesn't come back byte for byte; as a backstop, when one set of bytes reaches 25 ids (re-uploads
 *   of one screenshot below that are only counted in the summary).
 * - Reruns skip what's done. Ctrl-C stops starting new requests and lets those in flight finish;
 *   twice exits at once.
 * - An original sent without an MD5 ETag is kept when it is as long as its Content-Length and
 *   decodes completely.
 *
 * The other steps (scripts/screenshots/run.ts) work from state.jsonl, never the records:
 * - `--make`: the sizes (scripts/screenshots/make.ts) into `<dir>/sizes/`; the originals are only read.
 * - `--upload local|prod`: makes what's missing, then brings the bucket in line (upload.ts): files,
 *   then each image's manifest, recorded in `<dir>/uploads/<target>.jsonl`. Afterwards run
 *   `bun run screenshots:flags --stage <same>` so search cards show them.
 * - `--recheck`: asks Imgur for each copied image's small thumbnail; images deleted there are
 *   marked removed, and the next upload deletes their files after DELETE_GRACE_MS.
 */
import { appendFileSync, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ATTEMPTS, CANARY, canaryDue, parseArgs, screenshotsDir, USAGE, UsageError, type ShotArgs } from './screenshots/args.js';
import { classify, type Outcome, type Reply } from './screenshots/classify.js';
import { decodes } from './screenshots/make.js';
import { runMake, runRecheck, runUpload } from './screenshots/run.js';
import { fetchImgur, imgurOriginal } from './screenshots/fetch.js';
import { EXT, kindOfMime, requestExt } from './screenshots/image.js';
import { backoffMs, pacer, pool, realClock } from './screenshots/pace.js';
import { collect, IMGUR_ID, readClone, readDisk, type PrintImage } from './screenshots/records.js';
import {
	duplicateGuard,
	formatEntry,
	originalPath,
	parseState,
	planWork,
	STATE_FILE,
	type StateEntry,
	type Wanted
} from './screenshots/state.js';

const root = join(import.meta.dirname, '..');

let args: ShotArgs;
try {
	args = parseArgs(process.argv.slice(2), {
		clone: process.env.RENDER_CLONE_DIR?.trim() || join(homedir(), 'data', 'factorio-mirror'),
		disk: join(root, 'data', 'raw', 'factorioprints'),
		root
	});
} catch (e) {
	if (e instanceof UsageError) {
		console.error(`${e.message}\n${USAGE}`);
		process.exit(1);
	}
	throw e;
}

const dir = screenshotsDir(root);
const stateFile = join(dir, STATE_FILE);
await mkdir(dir, { recursive: true });

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
const duration = (ms: number) => {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

// The steps after the fetch work from the run state alone.
if (args.mode !== 'fetch') {
	const { entries, bad } = parseState(await readFile(stateFile, 'utf8').catch(() => ''));
	if (bad) console.warn(`screenshots: skipped ${bad} unreadable line(s) in ${stateFile}`);
	const code =
		args.mode === 'make'
			? await runMake(dir, entries, args)
			: args.mode === 'upload'
				? await runUpload(dir, entries, args)
				: await runRecheck(dir, stateFile, entries, args);
	process.exit(code);
}

// What the prints use.
let records: PrintImage[];
try {
	records = await readClone(args.clone);
} catch (e) {
	console.error(`screenshots: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
}
const inClone = records.length;
if (args.disk) records = records.concat(await readDisk(args.disk, new Set(records.map((r) => r.print))));
let { wanted, noImage } = collect(records);
console.log(
	`screenshots: ${inClone} records in ${args.clone}` +
		(args.disk ? `, ${records.length - inClone} more in ${args.disk}` : '') +
		`; ${wanted.length} images (${noImage.length} prints without one)`
);

if (args.ids) {
	const asked = new Set(args.ids);
	const found = new Set<string>();
	wanted = wanted.filter((w) => {
		const hits = [w.id, ...w.prints].filter((x) => asked.has(x));
		for (const h of hits) found.add(h);
		return hits.length > 0;
	});
	// An Imgur id no record names is fetched anyway (asked for by hand).
	for (const id of args.ids) {
		if (found.has(id) || !IMGUR_ID.test(id)) continue;
		wanted.push({ id, prints: [], labelled: null });
		found.add(id);
	}
	const missing = args.ids.filter((id) => !found.has(id));
	if (missing.length) console.warn(`screenshots: no record has ${missing.join(', ')}`);
}

const { entries, bad } = parseState(await readFile(stateFile, 'utf8').catch(() => ''));
if (bad) console.warn(`screenshots: skipped ${bad} unreadable line(s) in ${stateFile}`);
const plan = planWork(wanted, entries, { recheckDead: args.recheckDead, hasFile: (e) => !!e.file && existsSync(join(dir, e.file)) });
const todo = args.limit ? plan.todo.slice(0, args.limit) : plan.todo;
console.log(
	`screenshots: ${plan.done} already copied, ${plan.dead} dead; to fetch ${plan.todo.length}` +
		` (${plan.retrying} failed before, ${plan.missing} files missing, ${plan.recheck} dead rechecked)` +
		(args.limit ? `, this run ${todo.length}` : '') +
		` → ${dir}`
);
/** With --json: the fetch's counts as the last stdout line (the one-click update's step details). */
const result = (r: { fetched: number; newlyDead: number; failed: number; stopped: boolean }) => {
	if (args.json)
		console.log(JSON.stringify({ mode: 'fetch', alreadyCopied: plan.done, dead: plan.dead, toFetch: plan.todo.length, dir, ...r }));
};
if (args.planOnly || todo.length === 0) {
	result({ fetched: 0, newlyDead: 0, failed: 0, stopped: false });
	process.exit(0);
}

// The run.
const pace = pacer(args.rate);
const abort = new AbortController();
let stopReason: string | null = null;
let interrupted = false;
const halted = () => stopReason !== null || interrupted;
process.on('SIGINT', () => {
	if (interrupted) {
		abort.abort();
		process.exit(130);
	}
	interrupted = true;
	console.log('\nscreenshots: stopping after the requests in flight (Ctrl-C again to quit now)');
});

const record = (e: StateEntry) => appendFileSync(stateFile, formatEntry(e));
const now = () => new Date().toISOString();

/** One request, as an Outcome; network errors and timeouts are worth a retry. */
async function ask(id: string, ext: string): Promise<{ outcome: Outcome; reply: Reply | null }> {
	try {
		const reply = await fetchImgur(imgurOriginal(id, ext), abort.signal);
		return { outcome: classify(reply), reply };
	} catch (e) {
		const msg = e instanceof Error ? (e.name === 'TimeoutError' ? 'timed out' : e.message) : String(e);
		return { outcome: { kind: 'retry', reason: `request failed: ${msg}` }, reply: null };
	}
}

// Canary: a known image (the run's oldest stored one, else CANARY) must come back byte for byte,
// before anything is stored and again every CANARY_EVERY stored images. Null when it did.
const own = [...entries.values()].filter((e) => e.status === 'fetched' && e.md5 && e.type).sort((a, b) => (a.at < b.at ? -1 : 1))[0];
const candidates = [...(own ? [{ id: own.id, ext: EXT[own.type!], md5: own.md5! }] : []), CANARY];
async function canary(): Promise<string | null> {
	const seen: string[] = [];
	for (const c of candidates) {
		await pace.take();
		const { outcome } = await ask(c.id, c.ext);
		if (outcome.kind === 'ok' && outcome.md5 === c.md5) return null;
		seen.push(`${c.id}: ${outcome.kind === 'ok' ? `different bytes (MD5 ${outcome.md5})` : `${outcome.kind}, ${outcome.reason}`}`);
		if (outcome.kind === 'stop') break;
	}
	return seen.join('; ');
}
if (args.canary) {
	const failure = await canary();
	if (failure) {
		console.error(
			`screenshots: canary failed (${failure}). Imgur may be serving a placeholder or refusing this machine; nothing was fetched.`
		);
		process.exit(2);
	}
}

const guard = duplicateGuard();
for (const e of entries.values()) if (e.status === 'fetched' && e.md5) guard.add(e.md5, e.id);

const started = Date.now();
let settled = 0;
let fetched = 0;
let bytes = 0;
let dead = 0;
const failed = new Map<string, number>();
const mismatch = new Map<string, number>();

async function one(w: Wanted) {
	const ext = requestExt(w.labelled);
	let attempts = 0;
	let got: Awaited<ReturnType<typeof ask>>;
	for (;;) {
		attempts++;
		await pace.take();
		if (abort.signal.aborted || stopReason) return;
		got = await ask(w.id, ext);
		if (got.outcome.kind !== 'retry' || attempts >= ATTEMPTS) break;
		await realClock.sleep(backoffMs(attempts));
		if (halted()) return;
	}
	const o = got.outcome;
	const base = { id: w.id, prints: w.prints, labelled: w.labelled, attempts, at: now() };
	if (o.kind === 'stop') {
		stopReason ??= `${w.id}: ${o.reason}`;
		return;
	}
	if (o.kind === 'ok' && o.check === 'length' && !(await decodes(got.reply!.body!))) {
		record({ ...base, status: 'failed', reason: 'no MD5 ETag, and the body does not decode completely' });
		failed.set('no MD5 ETag, does not decode', (failed.get('no MD5 ETag, does not decode') ?? 0) + 1);
	} else if (o.kind === 'ok') {
		const dup = guard.check(o.md5, w.id);
		if (dup.tripped) {
			stopReason ??= `${w.id}: the same bytes (MD5 ${o.md5}) as ${dup.others.join(', ')}; a placeholder in place of the images?`;
			return;
		}
		const file = originalPath(w.id, o.ext);
		const path = join(dir, file);
		const tmp = `${path}.tmp-${process.pid}`;
		await mkdir(dirname(path), { recursive: true });
		try {
			await writeFile(tmp, got.reply!.body!);
			await rename(tmp, path);
		} catch (e) {
			await rm(tmp, { force: true });
			throw e;
		}
		record({ ...base, status: 'fetched', file, type: o.type, bytes: o.bytes, md5: o.md5, width: o.width, height: o.height });
		guard.add(o.md5, w.id);
		fetched++;
		bytes += o.bytes;
		const said = kindOfMime(w.labelled);
		if (said && said !== o.type) mismatch.set(`${said}→${o.type}`, (mismatch.get(`${said}→${o.type}`) ?? 0) + 1);
		if (args.canary && canaryDue(fetched)) {
			const failure = await canary();
			if (failure) stopReason ??= `canary failed after ${fetched} stored (${failure}); a placeholder in place of the images?`;
		}
	} else if (o.kind === 'dead') {
		record({ ...base, status: 'dead', reason: o.reason });
		dead++;
	} else {
		const reason = o.kind === 'retry' ? `${o.reason} (after ${attempts} tries)` : o.reason;
		record({ ...base, status: 'failed', reason });
		failed.set(o.reason, (failed.get(o.reason) ?? 0) + 1);
	}
	settled++;
}

const progress = () => {
	const s = (Date.now() - started) / 1000;
	const rate = settled / Math.max(1, s);
	const eta = rate > 0 ? duration(((todo.length - settled) / rate) * 1000) : '?';
	const nFailed = [...failed.values()].reduce((a, b) => a + b, 0);
	console.log(
		`screenshots: ${settled}/${todo.length} · ${rate.toFixed(1)}/s · fetched ${fetched} (${mb(bytes)}) · dead ${dead} · failed ${nFailed} · ETA ${eta}`
	);
};
const ticker = setInterval(progress, 15_000);
await pool(todo, args.inFlight, one, halted);
clearInterval(ticker);

const nFailed = [...failed.values()].reduce((a, b) => a + b, 0);
const list = (m: Map<string, number>) => [...m].map(([k, v]) => `${k} ${v}`).join(', ');
console.log(
	`screenshots: ${stopReason ? 'stopped' : interrupted ? 'interrupted' : 'done'} in ${duration(Date.now() - started)}: ` +
		`fetched ${fetched} (${mb(bytes)}), dead ${dead}, failed ${nFailed}, ` +
		`served as another type than the record says ${[...mismatch.values()].reduce((a, b) => a + b, 0)}${mismatch.size ? ` (${list(mismatch)})` : ''}; ` +
		`${todo.length - settled} of this run's ${todo.length} not done`
);
if (failed.size) console.log(`screenshots: failures: ${list(failed)}`);
const rep = guard.repeated();
if (rep.sets)
	console.log(`screenshots: identical bytes under several ids (state included): ${rep.sets} sets, ${rep.ids} ids, largest ${rep.largest}`);
if (stopReason) console.error(`screenshots: STOPPED: ${stopReason}`);
result({ fetched, newlyDead: dead, failed: nFailed, stopped: !!stopReason || interrupted });
process.exit(stopReason ? 2 : interrupted ? 130 : 0);
