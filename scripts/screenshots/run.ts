/**
 * `bun run screenshots --make | --upload local|prod | --recheck`: the steps after the fetch, over
 * the images in the run state (state.jsonl). Make and upload never ask Imgur anything; recheck
 * asks for each copied image's small thumbnail.
 */
import { appendFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ATTEMPTS, CANARY, type ShotArgs } from './args.js';
import { classifyCheck, type CheckOutcome } from './classify.js';
import { fetchImgur, imgurOriginal, imgurThumb } from './fetch.js';
import { formatLine, ledgerFile, readLedger, type LedgerLine } from './ledger.js';
import { EXT } from './image.js';
import { makeSizes, readMade, type Made } from './make.js';
import { backoffMs, pacer, pool, realClock } from './pace.js';
import { formatEntry, type StateEntry } from './state.js';
import { openShotStore } from './store.js';
import { syncImage } from './upload.js';

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
			try {
				const m = fetchedOnly(e) ? await ensureMade(dir, e) : null;
				if (m?.fresh) made++;
				const r = await syncImage({ dir, store: opened.store, held, append }, e, m?.made ?? null);
				if (r) {
					put += r.put;
					bytes += r.bytes;
					deleted += r.deleted;
					if (r.unchanged) unchanged++;
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				failed.push(`${e.id}: ${msg}`);
				// The store refusing us (401/403) won't get better for the next image.
				if ((err as { fatal?: boolean }).fatal) stop = msg;
			}
			done++;
		},
		() => stop !== null
	);
	clearInterval(ticker);
	await opened.dispose();
	console.log(
		`screenshots: ${target} bucket: ${done} images in ${secs(Date.now() - started)}: made ${made}, put ${put} files (${mb(bytes)}), ` +
			`deleted ${deleted}, already up ${unchanged}, failed ${failed.length}. Then: bun run screenshots:flags --stage ${target}`
	);
	for (const f of failed.slice(0, 20)) console.log(`  ${f}`);
	if (stop) console.error(`screenshots: STOPPED: ${stop}`);
	return stop ? 2 : failed.length ? 1 : 0;
}

/**
 * Most images deleted on Imgur in one recheck before it believes none of them: a mass "deleted"
 * is far likelier to be Imgur answering oddly than authors deleting at once.
 */
export const MAX_GONE = { count: 50, share: 0.05 };
export const tooManyGone = (gone: number, checked: number) => gone > MAX_GONE.count && gone > checked * MAX_GONE.share;

export async function runRecheck(dir: string, stateFile: string, entries: Map<string, StateEntry>, args: ShotArgs): Promise<number> {
	const todo = selectEntries(entries.values(), args.ids, args.limit, (e) => e.status === 'fetched');
	console.log(`screenshots: rechecking ${todo.length} copied images on Imgur, at most ${args.rate}/s`);
	const pace = pacer(args.rate);
	const abort = new AbortController();
	const once = async (url: string): Promise<CheckOutcome> => {
		for (let attempt = 1; ; attempt++) {
			await pace.take();
			let o: CheckOutcome;
			try {
				o = classifyCheck(await fetchImgur(url, abort.signal));
			} catch (e) {
				o = { kind: 'retry', reason: e instanceof Error ? e.message : String(e) };
			}
			if (o.kind !== 'retry' || attempt >= ATTEMPTS) return o;
			await realClock.sleep(backoffMs(attempt));
		}
	};
	// The small thumbnail is the cheap question; some ids (8 characters) have none and redirect to
	// their page, so an unclear answer asks for the original instead.
	const ask = async (id: string, type?: StateEntry['type']): Promise<CheckOutcome> => {
		const o = await once(imgurThumb(id));
		return o.kind === 'unknown' && type ? once(imgurOriginal(id, EXT[type])) : o;
	};
	if (args.canary) {
		const c = await ask(CANARY.id);
		if (c.kind !== 'alive') {
			console.error(
				`screenshots: canary ${CANARY.id} isn't answered as an image (${c.kind}${'reason' in c ? `: ${c.reason}` : ''}); nothing checked.`
			);
			return 2;
		}
	}
	const started = Date.now();
	let checked = 0;
	let stop: string | null = null;
	const gone: { e: StateEntry; reason: string }[] = [];
	const unknown: string[] = [];
	const ticker = setInterval(() => console.log(`screenshots: checked ${checked}/${todo.length} · deleted on Imgur ${gone.length}`), 15_000);
	await pool(
		todo,
		args.inFlight,
		async (e) => {
			const o = await ask(e.id, e.type);
			if (o.kind === 'stop') stop ??= `${e.id}: ${o.reason}`;
			else if (o.kind === 'gone') gone.push({ e, reason: o.reason });
			else if (o.kind !== 'alive') unknown.push(`${e.id}: ${o.reason}`);
			checked++;
		},
		() => stop !== null
	);
	clearInterval(ticker);
	console.log(
		`screenshots: checked ${checked} in ${secs(Date.now() - started)}: deleted on Imgur ${gone.length}, unclear ${unknown.length}` +
			(gone.length ? ` (${gone.map((g) => g.e.id).join(', ')})` : '')
	);
	for (const u of unknown.slice(0, 20)) console.log(`  ${u}`);
	if (stop) {
		console.error(`screenshots: STOPPED: ${stop}; nothing recorded`);
		return 2;
	}
	if (tooManyGone(gone.length, checked)) {
		console.error(`screenshots: ${gone.length} of ${checked} look deleted, too many to believe; nothing recorded`);
		return 2;
	}
	const at = new Date().toISOString();
	for (const { e, reason } of gone)
		appendFileSync(stateFile, formatEntry({ ...e, status: 'removed', by: 'imgur', reason: `deleted on Imgur (${reason})`, at }));
	if (gone.length)
		console.log(
			`screenshots: marked ${gone.length} removed. Next: --upload (their files go after the grace period), then screenshots:flags`
		);
	return 0;
}
