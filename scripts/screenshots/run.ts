/**
 * `bun run screenshots --make | --upload local|prod`: the steps after the fetch, over the images in
 * the run state (state.jsonl). Neither asks Imgur anything.
 */
import { appendFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ShotArgs } from './args.js';
import { formatLine, ledgerFile, readLedger, type LedgerLine } from './ledger.js';
import { makeSizes, readMade, type Made } from './make.js';
import { pool } from './pace.js';
import type { StateEntry } from './state.js';
import { openShotStore } from './store.js';
import { syncImage } from './upload.js';
import { isUploadImage } from '#lib/screenshots.js';

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

/** The entries a step works on: `--ids` (Imgur or print ids) narrow them, `--limit` caps them. */
export function selectEntries(entries: Iterable<StateEntry>, ids: string[] | null, limit: number | null, keep: (e: StateEntry) => boolean) {
	const asked = ids ? new Set(ids) : null;
	const out = [...entries].filter((e) => keep(e) && (!asked || asked.has(e.id) || e.prints.some((p) => asked.has(p))));
	return limit ? out.slice(0, limit) : out;
}

/** Made at this version already, or made now from the original on disk. */
async function ensureMade(dir: string, e: StateEntry): Promise<{ made: Made; fresh: boolean }> {
	const had = await readMade(dir, e.id);
	if (had) return { made: had, fresh: false };
	return { made: await makeSizes(dir, e.id, e.type!, new Uint8Array(await readFile(join(dir, e.file!)))), fresh: true };
}

const fetchedOnly = (e: StateEntry) => e.status === 'fetched' && !!e.file && !!e.type;

export async function runMake(dir: string, entries: Map<string, StateEntry>, args: ShotArgs): Promise<number> {
	const todo = selectEntries(entries.values(), args.ids, null, fetchedOnly);
	const pending: StateEntry[] = [];
	for (const e of todo) if (!(await readMade(dir, e.id))) pending.push(e);
	const work = args.limit ? pending.slice(0, args.limit) : pending;
	console.log(
		`screenshots: ${todo.length} copied images, ${todo.length - pending.length} made already; making ${work.length} with ${args.jobs} at once`
	);
	const started = Date.now();
	let done = 0;
	let bytes = 0;
	const failed: string[] = [];
	const ticker = setInterval(
		() => console.log(`screenshots: made ${done}/${work.length} · ${mb(bytes)} · ${secs(Date.now() - started)}`),
		15_000
	);
	await pool(
		work,
		args.jobs,
		async (e) => {
			try {
				const { made } = await ensureMade(dir, e);
				bytes += Object.values(made.bytes).reduce((a, b) => a + b, 0);
			} catch (err) {
				failed.push(`${e.id}: ${err instanceof Error ? err.message : String(err)}`);
			}
			done++;
		},
		() => false
	);
	clearInterval(ticker);
	console.log(`screenshots: made ${done - failed.length} (${mb(bytes)}) in ${secs(Date.now() - started)}; failed ${failed.length}`);
	for (const f of failed.slice(0, 20)) console.log(`  ${f}`);
	return failed.length ? 1 : 0;
}

/** The upload images (`upload.…`) among an upload run's counts. */
export interface UploadBucketCounts {
	images: number;
	made: number;
	put: number;
	bytes: number;
	deleted: number;
	alreadyUp: number;
	failed: number;
}

/** `--upload` with --json: its counts as the last stdout line. The totals include `uploads`. */
export interface UploadRunResult {
	mode: 'upload';
	target: string;
	images: number;
	made: number;
	put: number;
	bytes: number;
	deleted: number;
	alreadyUp: number;
	failed: number;
	stopped: boolean;
	uploads: UploadBucketCounts;
	/** The run's line for people: `prod bucket: 18120 images in 830s: made 89, …, failed 0`. */
	summary: string;
}

export async function runUpload(dir: string, entries: Map<string, StateEntry>, args: ShotArgs): Promise<number> {
	const target = args.target!;
	const file = join(dir, ledgerFile(target));
	const { held, bad } = readLedger(await readFile(file, 'utf8').catch(() => ''));
	if (bad) console.warn(`screenshots: skipped ${bad} unreadable line(s) in ${file}`);
	const todo = selectEntries(entries.values(), args.ids, args.limit, (e) => e.status !== 'failed');
	console.log(`screenshots: ${todo.length} images to bring in line in the ${target} bucket (${held.size} uploaded there before)`);
	if (args.planOnly) return 0;
	await mkdir(dirname(file), { recursive: true });
	const append = (l: LedgerLine) => appendFileSync(file, formatLine(l));
	let opened;
	try {
		opened = await openShotStore(target);
	} catch (e) {
		console.error(`screenshots: ${e instanceof Error ? e.message : String(e)}`);
		return 2;
	}
	const started = Date.now();
	let done = 0;
	let made = 0;
	let put = 0;
	let bytes = 0;
	let deleted = 0;
	let unchanged = 0;
	const failed: string[] = [];
	// Upload screenshots (`upload.…`) by themselves too (a part of the totals above): the update shows them as
	// their own group and the rest as the bucket's.
	const uploads: UploadBucketCounts = { images: 0, made: 0, put: 0, bytes: 0, deleted: 0, alreadyUp: 0, failed: 0 };
	let stop: string | null = null;
	const ticker = setInterval(
		() =>
			console.log(
				`screenshots: ${done}/${todo.length} · made ${made} · put ${put} files (${mb(bytes)}) · deleted ${deleted} · ${secs(Date.now() - started)}`
			),
		15_000
	);
	await pool(
		todo,
		args.jobs,
		async (e) => {
			const upload = isUploadImage(e.id);
			if (upload) uploads.images++;
			try {
				const m = fetchedOnly(e) ? await ensureMade(dir, e) : null;
				if (m?.fresh) {
					made++;
					if (upload) uploads.made++;
				}
				const r = await syncImage({ dir, store: opened.store, held, append }, e, m?.made ?? null);
				if (r) {
					put += r.put;
					bytes += r.bytes;
					deleted += r.deleted;
					if (r.unchanged) unchanged++;
					if (upload) {
						uploads.put += r.put;
						uploads.bytes += r.bytes;
						uploads.deleted += r.deleted;
						if (r.unchanged) uploads.alreadyUp++;
					}
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				failed.push(`${e.id}: ${msg}`);
				if (upload) uploads.failed++;
				// The store refusing us (401/403) won't get better for the next image.
				if ((err as { fatal?: boolean }).fatal) stop = msg;
			}
			done++;
		},
		() => stop !== null
	);
	clearInterval(ticker);
	await opened.dispose();
	const summary =
		`${target} bucket: ${done} images in ${secs(Date.now() - started)}: made ${made}, put ${put} files (${mb(bytes)}), ` +
		`deleted ${deleted}, already up ${unchanged}, failed ${failed.length}`;
	console.log(`screenshots: ${summary}. Then: bun run screenshots:flags --stage ${target}`);
	for (const f of failed.slice(0, 20)) console.log(`  ${f}`);
	if (stop) console.error(`screenshots: STOPPED: ${stop}`);
	if (args.json)
		console.log(
			JSON.stringify({
				mode: 'upload',
				target,
				images: done,
				made,
				put,
				bytes,
				deleted,
				alreadyUp: unchanged,
				failed: failed.length,
				stopped: !!stop,
				uploads,
				summary
			} satisfies UploadRunResult)
		);
	return stop ? 2 : failed.length ? 1 : 0;
}
