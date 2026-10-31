/**
 * The upload queue of `bun run render --upload local|prod`: puts rendered pages into a RENDERS
 * bucket (store.ts) while the run goes on rendering, so each finished page appears on the site that
 * reads that bucket.
 *
 * The unit of work is a print: syncing one brings the bucket in line with its render_jobs rows.
 * Per page: its tiles not in the bucket yet, `<page>.<stamp>.avif` and `<page>.page.json`, all at
 * once, then `<page>.json` (the sidecar) once they are all up. Then the print's `index.json`,
 * rebuilt from the pages whose files are up, then (scheduling a re-rendered page's previous
 * overview for deletion) the render_uploads rows of the pages it newly lists. The index goes up
 * once the print's pages are done, and in between at most every `indexEveryMs` (a big book shows
 * its progress, and a crash costs at most that much work). Every object
 * gets the Cache-Control of renderCacheControl (#lib/viewer/game-render.js): images for good,
 * index.json a minute, sidecars and page data five minutes. So:
 * - The remote index never lists a page whose files aren't all there, and a row never says a page
 *   is up that the remote index doesn't list. A page being re-rendered stays listed at the version
 *   that is up until its new files are.
 * - A run killed at any point repeats at most the pages up since the last index: their rows are
 *   written last, and tiles are checked against the bucket's own listing (one LIST per print,
 *   cached), so tiles that made it up are not sent again.
 * - Up to `pageConcurrency` pages of one print go up at once, prints in parallel. A tile two of
 *   them use is sent once, by the earlier page in book order (as one at a time would), and the
 *   other page's sidecar waits for it. At most `concurrency` requests are in flight, and a file is
 *   read only once its request has a slot. Pause holds new requests; stop finishes the pages each
 *   print has in flight (and their index); abort cancels the requests in flight (those pages go up
 *   next time).
 *
 * Deleting: pages whose row is gone, failed or skipped are dropped from the index, then their files
 * are scheduled for deletion. Objects no uploaded page uses (tiles of an older version) are
 * scheduled only when every uploaded page of the print is, on disk, the exact version in the
 * bucket, since only then is the set the bucket's sidecars use known. Otherwise the sweep waits for
 * a later sync.
 *
 * Nothing but an emptied index.json is deleted at once. A browser or the edge may hold a page's
 * sidecar (`max-age=300`) or the index (`max-age=60`) from before a re-render, and ask for the
 * files they name; deleting those at once would give it a 404, which the edge then caches too. So
 * each key goes into render_deletes with a time `graceMs` ahead, and processDeletes(), which the
 * runner calls as a run starts and before it exits, deletes the keys that are due. Before deleting,
 * it checks the key against what the bucket holds now (render_uploads, and the tiles of the
 * uploaded versions' sidecars on disk): a key that is used again loses its row instead, and a tile
 * waits while the print's uploaded tiles aren't known. A page that goes up (sent or reused) cancels
 * the pending deletions of every key it uses, so a stamp going A → B → A never loses A's files, and
 * a key scheduled again keeps its first time only while nothing has used it since.
 *
 * Page thumbnails (thumb-step.ts) go up after a print's render files: the thumb step waits on
 * `settled(id)`, which resolves once the print has no sync queued or running. A sync that failed
 * and waits on its retry timer counts as settled, so a print's thumbs.json can go up before its
 * re-sent overview does. That is harmless: thumbnails are files of their own, named by the stamp.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	overviewFile,
	pageBase,
	pageDataFile,
	renderCacheControl,
	sidecarFile,
	tileHashFile,
	type RenderSidecar
} from '#lib/viewer/game-render.js';
import { buildIndex, comparePaths, readSidecar } from './files.js';
import type { RenderJobRow } from '#lib/server/render-queue.js';
import { isAbort, StoreError, withRetries, type RenderStore, type RetryOptions } from './store.js';

export const UPLOAD_TARGETS = ['local', 'prod'] as const;

/** How long a replaced file stays in the bucket: well past the viewer's 300 s sidecar cache plus the 60 s index cache. */
export const DELETE_GRACE_MS = 15 * 60_000;
/** Pages of one print going up at once: a page's last steps (sidecar, then the index) are round trips that other pages' files can fill. */
export const PAGE_CONCURRENCY = 4;
/** How often a print's index.json goes up while its pages do (a big book's pages show on the site as they go, and a crash repeats at most this much). */
export const INDEX_EVERY_MS = 30_000;

/** The shortest grace period that is safe for a bucket behind a cache (RENDER_DELETE_GRACE_S below it is for local tests only). */
export const MIN_DELETE_GRACE_MS = 360_000;

/** A render_deletes row that is due. */
export interface DueDelete {
	key: string;
	print_id: string;
	reason: string;
}
export type UploadTarget = (typeof UPLOAD_TARGETS)[number];

export interface UploadRow {
	target: string;
	print_id: string;
	path: string;
	stamp: string | null;
	rendered_at: string | null;
	stale: number;
	files: number | null;
	bytes: number | null;
	uploaded_at: number | null;
	error: string | null;
	failed_at: number | null;
}

export type UploadJob = Pick<RenderJobRow, 'print_id' | 'path' | 'status' | 'stamp' | 'finished_at'>;

/** Rows whose pages may have files in the bucket: rendered, or being rendered again (the old version stays up). */
const KEEPS_FILES = new Set<string>(['done', 'pending', 'rendering']);

/** The page's current render is in the bucket. */
export const uploadCurrent = (job: UploadJob, up: UploadRow | undefined) =>
	!!up && up.stamp !== null && up.stamp === job.stamp && !up.stale && (up.uploaded_at ?? 0) >= (job.finished_at ?? 0);

export interface PrintPlan {
	/** Done pages whose current render isn't up, in book order. */
	upload: UploadJob[];
	/** Uploaded pages that stay in the index (at their uploaded stamp). */
	listed: UploadRow[];
	/** Upload rows of pages that are gone, failed or skipped: out of the index, files deleted. */
	orphans: UploadRow[];
}

export function planPrint(jobs: UploadJob[], uploads: UploadRow[]): PrintPlan {
	const jobBy = new Map(jobs.map((j) => [j.path, j]));
	const upBy = new Map(uploads.map((u) => [u.path, u]));
	const keep = (u: UploadRow) => KEEPS_FILES.has(jobBy.get(u.path)?.status ?? '');
	return {
		upload: jobs
			.filter((j) => j.status === 'done' && j.stamp && !uploadCurrent(j, upBy.get(j.path)))
			.sort((a, b) => comparePaths(a.path, b.path)),
		listed: uploads.filter((u) => u.stamp !== null && keep(u)),
		orphans: uploads.filter((u) => !keep(u))
	};
}

/** Whether a sync of the print would do anything. */
export const hasUploadWork = (plan: PrintPlan) => plan.upload.length > 0 || plan.orphans.length > 0;

/** The remote index.json for these uploaded pages, or null when there are none. */
export const remoteIndex = (listed: Pick<UploadRow, 'path' | 'stamp'>[]) =>
	buildIndex(listed.filter((u) => u.stamp).map((u) => ({ path: u.path, stamp: u.stamp, overview: overviewFile(u.path, u.stamp!) })));

/** Objects this uploader puts under `<id>/`, including overviews named `<base>.avif` before they carried the stamp. */
const OURS = /^(?:(?:root|\d+(?:\/\d+)*)(?:\.(?:[0-9a-f]{10}\.)?avif|\.json|\.page\.json)|t\/[0-9a-f]{16}\.avif|index\.json)$/;
/** A page's overview under its old, unstamped name. */
const legacyOverview = (path: string) => `${pageBase(path)}.avif`;

export interface UploaderDb {
	jobsOf(printId: string): Promise<UploadJob[]>;
	uploadsOf(target: string, printId: string): Promise<UploadRow[]>;
	/** Upsert the row (clearing its error); for prod also render_jobs.uploaded_at. */
	recordUpload(row: UploadRow): Promise<unknown>;
	recordFailure(target: string, printId: string, path: string, error: string, at: number): Promise<unknown>;
	forgetUploads(target: string, printId: string, paths: string[]): Promise<unknown>;
	/** render_deletes (migration 0012): a key already waiting keeps its time. */
	scheduleDeletes(
		target: string,
		rows: { key: string; print_id: string; reason: string }[],
		notBefore: number,
		queuedAt: number
	): Promise<unknown>;
	pendingDeletesOf(target: string, printId: string): Promise<string[]>;
	/** Due at `at`, in key order after `after`. */
	dueDeletes(target: string, at: number, after: string, limit: number): Promise<DueDelete[]>;
	dropDeletes(target: string, keys: string[]): Promise<unknown>;
	countDeletes(target: string): Promise<{ n: number; next: number | null }>;
}

export interface UploaderOptions {
	target: string;
	store: RenderStore;
	db: UploaderDb;
	/** The renders folder (OUT_DIR: RENDERS_DIR, else data/renders). */
	outDir: string;
	/** Requests in flight at most. */
	concurrency: number;
	/** Pages of one print going up at once (default PAGE_CONCURRENCY). */
	pageConcurrency?: number;
	/** While a print's pages go up, its index.json goes up at most this often (default INDEX_EVERY_MS); always once they're done. */
	indexEveryMs?: number;
	log: (line: string) => void;
	/** Per-request retries (tests pass a fake sleep). */
	retry?: Omit<RetryOptions, 'signal'>;
	/** Delay before syncing a print again after a failed sync (`round` from 1). */
	retryDelayMs?: (round: number) => number;
	/** Once the run has stopped rendering, give up on a print after this many failed syncs. */
	maxRounds?: number;
	/** How long a replaced or unused object stays before it may be deleted (default DELETE_GRACE_MS). */
	graceMs?: number;
	now?: () => number;
	/**
	 * Whether the target's stage deleted or blocked the print (removed-guard.ts), asked before each sync
	 * of a print: such a print is never uploaded. Throwing counts as a failed sync (tried again later).
	 */
	removed?: (id: string) => Promise<boolean>;
	/** After each page whose files and index entry went up, with the objects and bytes it put (the run's per-site counts). */
	onPageUp?: (id: string, files: number, bytes: number) => void;
}

export interface UploadStats {
	/** Pages whose files and index entry went up. */
	pages: number;
	/** Objects put (index rewrites not counted) and their bytes. */
	files: number;
	bytes: number;
	/** Tiles that were in the bucket already. */
	reused: number;
	/** Objects deleted from the bucket (due deletions, and emptied indexes). */
	deleted: number;
	/** Keys put into render_deletes, and pending deletions dropped because a page uses the key again. */
	deletesScheduled: number;
	/** Pages put at a new stamp over an older one in the bucket, and pages dropped from the index. */
	replaced: number;
	removed: number;
	deletesCancelled: number;
	indexes: number;
	/** Sweeps of unused objects put off because the bucket holds older versions of some pages. */
	sweepsDeferred: number;
	lastError: string | null;
}

/** Upload speed for the run row: bytes and files over the last minute, pages over the last 5 minutes (the render rate's window). */
export const BYTE_RATE_WINDOW_MS = 60_000;
export const PAGE_RATE_WINDOW_MS = 5 * 60_000;

/**
 * Amounts completed over a sliding window, for a rate. Its clock starts at the first `start()` or
 * `add()`, so the first minute of uploading isn't diluted by the time before it.
 */
export function rateWindow(windowMs: number, now: () => number) {
	const events: { t: number; n: number }[] = [];
	let head = 0;
	let sum = 0;
	let since: number | null = null;
	const prune = (t: number) => {
		while (head < events.length && events[head].t <= t - windowMs) sum -= events[head++].n;
		if (head > 1024 && head * 2 > events.length) {
			events.splice(0, head);
			head = 0;
		}
	};
	return {
		start() {
			since ??= now();
		},
		add(n: number) {
			const t = now();
			since ??= t;
			events.push({ t, n });
			sum += n;
			prune(t);
		},
		/** Per second over the window (or since the start, when that's shorter); null before anything started. */
		perSecond(): number | null {
			if (since === null) return null;
			const t = now();
			prune(t);
			const span = Math.min(windowMs, t - since);
			return span > 0 ? (sum * 1000) / span : null;
		}
	};
}

const LISTING_CACHE = 64;
/** render_uploads rows written at once after an index went up. */
const ROW_WRITES = 8;
/** Due deletions read per query. */
const DUE_BATCH = 1000;
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Run `n` workers to the end, every one of them, even after one throws (none is left writing after the caller moved on); then throw the first error. */
async function allWorkers(n: number, worker: () => Promise<void>) {
	const results = await Promise.allSettled(Array.from({ length: n }, worker));
	const failed = results.find((r) => r.status === 'rejected');
	if (failed) throw failed.reason;
}

export function createUploader(opts: UploaderOptions) {
	const { store, db, target, log } = opts;
	const now = opts.now ?? Date.now;
	const retryDelay = opts.retryDelayMs ?? ((round: number) => Math.min(600_000, 15_000 * 2 ** (round - 1)));
	const maxRounds = opts.maxRounds ?? 5;
	const graceMs = opts.graceMs ?? DELETE_GRACE_MS;
	const stats: UploadStats = {
		pages: 0,
		files: 0,
		bytes: 0,
		reused: 0,
		deleted: 0,
		deletesScheduled: 0,
		replaced: 0,
		removed: 0,
		deletesCancelled: 0,
		indexes: 0,
		sweepsDeferred: 0,
		lastError: null
	};
	/** Rows in render_deletes for the target: counted by processDeletes, kept up to date in between. */
	let deletesPending = 0;
	/** Objects put (index rewrites not counted, as in stats) and pages up, over sliding windows. */
	const byteWindow = rateWindow(BYTE_RATE_WINDOW_MS, now);
	const fileWindow = rateWindow(BYTE_RATE_WINDOW_MS, now);
	const pageWindow = rateWindow(PAGE_RATE_WINDOW_MS, now);

	const queue: string[] = [];
	const queued = new Set<string>();
	const running = new Map<string, Promise<void>>();
	/** settled(): callers waiting for a print to have no sync queued or running. */
	const settleWaiters = new Map<string, (() => void)[]>();
	const notifySettled = (id: string) => {
		if (queued.has(id) || running.has(id)) return;
		const ws = settleWaiters.get(id);
		settleWaiters.delete(id);
		for (const w of ws ?? []) w();
	};
	const settleAll = () => {
		const all = [...settleWaiters.values()].flat();
		settleWaiters.clear();
		for (const w of all) w();
	};
	const again = new Set<string>();
	const pendingByPrint = new Map<string, number>();
	const failingPages = new Set<string>();
	const rounds = new Map<string, number>();
	const timers = new Map<string, NodeJS.Timeout>();
	/** Keys under `<id>/` in the bucket, as listed and then kept up to date by our own puts and deletes. */
	const listings = new Map<string, Set<string>>();
	const ac = new AbortController();
	/** When the next pending deletion is due (unix ms), as of the last processDeletes. */
	let nextDue: number | null = null;
	let paused = false;
	let stopping = false;
	/** The run stopped rendering: failed prints get at most maxRounds syncs. */
	let finishing = false;
	let broken: string | null = null;
	let active = 0;
	const slotWaiters: (() => void)[] = [];
	let idleWaiters: (() => void)[] = [];

	const idle = () => running.size === 0 && (stopping || broken !== null || (queue.length === 0 && timers.size === 0));
	const checkIdle = () => {
		if (!idle()) return;
		const w = idleWaiters;
		idleWaiters = [];
		for (const f of w) f();
	};

	/** A request slot. `urgent` (everything but tiles) goes ahead of the queue, so a print's last steps never wait behind another print's tiles. */
	async function acquire(urgent: boolean) {
		while (!broken && (paused || active >= opts.concurrency)) {
			ac.signal.throwIfAborted();
			await new Promise<void>((resolve) => (urgent ? slotWaiters.unshift(resolve) : slotWaiters.push(resolve)));
		}
		ac.signal.throwIfAborted();
		// After a 401/403 no request starts: pages part-way up stop where they are (and go up next time).
		if (broken) throw new StoreError(`uploads stopped: ${broken}`, false);
		active++;
	}
	/** Every waiter re-checks (after a pause, an abort or a fatal error). */
	const wake = () => {
		for (const f of slotWaiters.splice(0)) f();
	};
	/** One slot is free: the next waiter (waking them all would cost O(waiters) per request). */
	const release = () => {
		active--;
		slotWaiters.shift()?.();
	};

	/** Run `f` holding a request slot. */
	async function withSlot<T>(urgent: boolean, f: () => Promise<T>): Promise<T> {
		await acquire(urgent);
		byteWindow.start();
		fileWindow.start();
		pageWindow.start();
		try {
			return await f();
		} finally {
			release();
		}
	}

	/** One store call with retries and abort (the caller holds a slot). */
	const retrying = <T>(what: string, f: (signal: AbortSignal) => Promise<T>) =>
		withRetries(() => f(ac.signal), {
			...opts.retry,
			signal: ac.signal,
			onRetry: (e, attempt, ms) => {
				stats.lastError = e.message;
				log(`  upload: ${what}: ${e.message}; retry ${attempt} in ${(ms / 1000).toFixed(1)} s`);
			}
		}).catch((e: unknown) => {
			// At once, not when the page's other files are done: no other page starts another request.
			if (e instanceof StoreError && e.fatal) breakOff(`${what}: ${message(e)}`, e);
			throw e;
		});

	/** One store call: a request slot, retries, abort. */
	const request = <T>(what: string, f: (signal: AbortSignal) => Promise<T>, urgent = true): Promise<T> =>
		withSlot(urgent, () => retrying(what, f));

	async function remoteKeys(id: string): Promise<Set<string>> {
		const hit = listings.get(id);
		if (hit) {
			listings.delete(id);
			listings.set(id, hit);
			return hit;
		}
		const keys = new Set(await request(`list ${id}/`, (signal) => store.list(`${id}/`, signal)));
		listings.set(id, keys);
		while (listings.size > LISTING_CACHE) listings.delete(listings.keys().next().value!);
		return keys;
	}

	async function put(id: string, rel: string, body: Uint8Array, contentType: string, remote: Set<string>) {
		const key = `${id}/${rel}`;
		await request(`put ${key}`, (signal) => store.put(key, body, contentType, renderCacheControl(rel), signal), !rel.startsWith('t/'));
		remote.add(key);
		if (rel !== 'index.json') {
			byteWindow.add(body.byteLength);
			fileWindow.add(1);
		}
	}

	/** Put a file from disk, read only once a slot is free (so files waiting for one hold no memory). Returns its bytes. */
	async function putFile(id: string, rel: string, file: string, contentType: string, remote: Set<string>) {
		const key = `${id}/${rel}`;
		const n = await withSlot(!rel.startsWith('t/'), async () => {
			const body = await readBody(file);
			await retrying(`put ${key}`, (signal) => store.put(key, body, contentType, renderCacheControl(rel), signal));
			return body.byteLength;
		});
		remote.add(key);
		byteWindow.add(n);
		fileWindow.add(1);
		return n;
	}

	/** Delete now: only for keys no cached file can name (an emptied index), and due deletions. */
	async function del(key: string) {
		const id = key.slice(0, key.indexOf('/'));
		try {
			await request(`delete ${key}`, (signal) => store.delete(key, signal));
		} catch (e) {
			// Whether it's still there is unknown now: list again next time.
			listings.delete(id);
			throw e;
		}
		listings.get(id)?.delete(key);
		stats.deleted++;
	}

	/** Schedule objects of print `id` for deletion after the grace period; they stay in the bucket (and its listing) till then. */
	async function deleteLater(id: string, rels: string[], reason: string, ctx: PrintCtx) {
		const keys = [...new Set(rels.map((rel) => `${id}/${rel}`))].filter((k) => !ctx.pending.has(k));
		if (!keys.length) return 0;
		const t = now();
		await db.scheduleDeletes(
			target,
			keys.map((key) => ({ key, print_id: id, reason })),
			t + graceMs,
			t
		);
		for (const k of keys) ctx.pending.add(k);
		stats.deletesScheduled += keys.length;
		deletesPending += keys.length;
		return keys.length;
	}

	/** Keys a page about to go up uses (sent or already there): their pending deletions are off. */
	async function cancelDeletes(keys: string[], ctx: PrintCtx) {
		const hit = keys.filter((k) => ctx.pending.has(k));
		if (!hit.length) return;
		// Taken off before the await, so pages going up at once never drop (and count) a key twice; put back if the drop fails.
		for (const k of hit) ctx.pending.delete(k);
		try {
			await db.dropDeletes(target, hit);
		} catch (e) {
			for (const k of hit) ctx.pending.add(k);
			throw e;
		}
		stats.deletesCancelled += hit.length;
		deletesPending = Math.max(0, deletesPending - hit.length);
	}

	const readBody = async (file: string) => {
		const body = await readFile(file);
		// Never send an empty file (a write cut short): the page is rendered again or fixed first.
		if (!body.byteLength) throw new StoreError(`${file} is empty`, false);
		return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	};

	async function writeIndex(id: string, listed: UploadRow[], remote: Set<string>) {
		const index = remoteIndex(listed);
		if (index) await put(id, 'index.json', new TextEncoder().encode(JSON.stringify(index)), 'application/json', remote);
		else if (remote.has(`${id}/index.json`)) {
			// At once: a print with no page up has no viewer, and the files a cached index named are deleted later.
			await del(`${id}/index.json`);
			remote.delete(`${id}/index.json`);
		}
		stats.indexes++;
	}

	/** The page's sidecar on disk, checked against its render_jobs row. */
	async function pageSidecar(dir: string, job: UploadJob) {
		const scBody = await readBody(join(dir, sidecarFile(job.path)));
		let sc: RenderSidecar;
		try {
			sc = JSON.parse(new TextDecoder().decode(scBody)) as RenderSidecar;
		} catch {
			throw new StoreError(`${sidecarFile(job.path)} doesn't parse; the next run renders the page again`, false);
		}
		if (sc.v !== 2 || sc.stamp !== job.stamp) {
			throw new StoreError(
				`the sidecar on disk (stamp ${sc.stamp}) isn't the render render_jobs records (${job.stamp}); the next run's queueing fixes the row`,
				false
			);
		}
		return { sc, scBody, hashes: [...new Set(sc.levels.flatMap((l) => l.tiles).filter(Boolean))] };
	}

	/** A tile another page claimed: once that page is done with it, up already, or else sent by this one. Returns the bytes sent, or null. */
	async function ensureTile(id: string, rel: string, dir: string, ctx: PrintCtx): Promise<number | null> {
		const key = `${id}/${rel}`;
		for (let claim = ctx.claims.get(key); !ctx.remote.has(key) && claim; claim = ctx.claims.get(key)) await claim;
		if (ctx.remote.has(key)) return null;
		let done!: () => void;
		ctx.claims.set(key, new Promise<void>((resolve) => (done = resolve)));
		try {
			return await putFile(id, rel, join(dir, rel), 'image/avif', ctx.remote);
		} finally {
			ctx.claims.delete(key);
			done();
		}
	}

	/**
	 * One page's files up: its tiles not in the bucket, overview and page data at once, then the
	 * sidecar. The index and its row come later (listPages). `turn` orders the pages' tile claims by
	 * book order: the page waits for `turn.prev` (the page before it claimed) and calls `turn.open`
	 * once it has claimed, so a tile two pages use is sent by the earlier one, as one at a time would.
	 */
	async function uploadPage(id: string, job: UploadJob, ctx: PrintCtx, turn: { prev: Promise<void>; open: () => void }): Promise<PageUp> {
		const { remote, claims } = ctx;
		const dir = join(opts.outDir, id);
		/** Tiles this page claimed: key → resolve the claim (others waiting on it look again). */
		const mine = new Map<string, () => void>();
		/** Tiles another page in flight claimed first. */
		const others: string[] = [];
		const settle = (key: string) => {
			const done = mine.get(key);
			if (!done) return;
			mine.delete(key);
			claims.delete(key);
			done();
		};
		let page: Awaited<ReturnType<typeof pageSidecar>> | null = null;
		try {
			page = await pageSidecar(dir, job);
		} finally {
			await turn.prev;
			for (const h of page?.hashes ?? []) {
				const key = `${id}/${tileHashFile(h)}`;
				if (remote.has(key)) continue;
				if (claims.has(key)) {
					others.push(tileHashFile(h));
					continue;
				}
				let done!: () => void;
				claims.set(key, new Promise<void>((resolve) => (done = resolve)));
				mine.set(key, done);
			}
			turn.open();
		}
		const { sc, scBody, hashes } = page!;
		try {
			await cancelDeletes(
				[sc.overview.file, pageDataFile(job.path), sidecarFile(job.path), ...hashes.map(tileHashFile)].map((rel) => `${id}/${rel}`),
				ctx
			);
			// The overview (named by its stamp) goes with the tiles; the page data and sidecar, rewritten in place, only once those are up.
			const tasks: [rel: string, type: string][] = [
				[sc.overview.file, 'image/avif'],
				...[...mine.keys()].map((key): [string, string] => [key.slice(id.length + 1), 'image/avif'])
			];
			let files = 0;
			let bytes = 0;
			let tilesSent = 0;
			let failure: unknown = null;
			// At most `concurrency` files of a page waiting for a slot at once: other prints' tiles take turns with a page of thousands.
			let next = 0;
			await Promise.all(
				Array.from({ length: Math.min(opts.concurrency, tasks.length) }, async () => {
					while (!failure && !broken && next < tasks.length) {
						const [rel, type] = tasks[next++];
						try {
							const n = await putFile(id, rel, join(dir, rel), type, remote);
							files++;
							bytes += n;
							if (rel.startsWith('t/')) tilesSent++;
						} catch (e) {
							failure ??= e;
						} finally {
							settle(`${id}/${rel}`);
						}
					}
				})
			);
			if (failure) throw failure;
			// The sidecar names these too: it waits until the pages that claimed them are done with them.
			for (const rel of others) {
				const n = await ensureTile(id, rel, dir, ctx);
				if (n === null) continue;
				files++;
				bytes += n;
				tilesSent++;
			}
			// Uploads broke (401/403) while this page went up: its other files may not all be there.
			if (broken) throw new StoreError(broken, false);
			const dataBytes = await putFile(id, pageDataFile(job.path), join(dir, pageDataFile(job.path)), 'application/json', remote);
			files++;
			bytes += dataBytes;
			await put(id, sidecarFile(job.path), scBody, 'application/json', remote);
			files++;
			bytes += scBody.byteLength;
			const row: UploadRow = {
				target,
				print_id: id,
				path: job.path,
				stamp: sc.stamp,
				rendered_at: sc.renderedAt,
				stale: 0,
				files,
				bytes,
				uploaded_at: now(),
				error: null,
				failed_at: null
			};
			return { job, row, overview: sc.overview.file, reused: hashes.length - tilesSent };
		} finally {
			for (const key of mine.keys()) settle(key);
		}
	}

	/**
	 * After the index that lists these pages went up: schedule each re-rendered page's previous
	 * overview for deletion (a cached sidecar may still name it), then write its row.
	 * `before`: the stamp each page was listed at before.
	 */
	async function listPage(id: string, up: PageUp, before: string | null | undefined, ctx: PrintCtx) {
		const { job, row } = up;
		if (before && before !== row.stamp) stats.replaced++;
		await deleteLater(
			id,
			[before ? overviewFile(job.path, before) : null, legacyOverview(job.path)].filter(
				(rel): rel is string => !!rel && rel !== up.overview && ctx.remote.has(`${id}/${rel}`)
			),
			'replaced',
			ctx
		);
		await db.recordUpload(row);
		const files = row.files ?? 0;
		const bytes = row.bytes ?? 0;
		stats.pages++;
		pageWindow.add(1);
		stats.files += files;
		stats.bytes += bytes;
		stats.reused += up.reused;
		opts.onPageUp?.(id, files, bytes);
		log(`  ↑ ${id} ${pageBase(job.path).padEnd(6)} ${files} files, ${mb(bytes)} (${up.reused} tiles already up)`);
	}

	/** The keys the print's uploaded pages use: their names, and their tiles if every uploaded version's sidecar is on disk (else null). */
	async function usedKeys(id: string, listed: Pick<UploadRow, 'path' | 'stamp' | 'rendered_at'>[]) {
		const names = new Set<string>();
		let tiles: Set<string> | null = new Set();
		let behind: string | null = null;
		if (listed.length) names.add('index.json');
		for (const u of listed) {
			if (!u.stamp) continue;
			names.add(overviewFile(u.path, u.stamp)).add(pageDataFile(u.path)).add(sidecarFile(u.path));
			if (!tiles) continue;
			const sc = await readSidecar(opts.outDir, id, u.path);
			if (!sc || sc.stamp !== u.stamp || sc.renderedAt !== u.rendered_at) {
				tiles = null;
				behind = u.path;
			} else {
				// The sidecar's own name for the overview too, should it differ.
				names.add(sc.overview.file);
				for (const l of sc.levels) for (const t of l.tiles) if (t) tiles.add(tileHashFile(t));
			}
		}
		return { names, tiles, behind };
	}

	/** Schedule objects no uploaded page uses for deletion, if the bucket's versions are all on disk. */
	async function sweep(id: string, listed: UploadRow[], ctx: PrintCtx) {
		const { remote } = ctx;
		const { names, tiles, behind } = await usedKeys(id, listed);
		if (!tiles) {
			if ([...remote].some((k) => k.startsWith(`${id}/t/`))) {
				stats.sweepsDeferred++;
				log(`  upload: ${id}: unused objects (if any) stay until page ${pageBase(behind!)} is up at its current version`);
			}
			return;
		}
		const expected = new Set([...names, ...tiles]);
		const extras = [...remote]
			.filter((k) => !ctx.pending.has(k))
			.map((k) => k.slice(id.length + 1))
			.filter((rel) => OURS.test(rel) && !expected.has(rel));
		if (!extras.length) return;
		// The index first, so it never names a page whose files are going.
		if (!ctx.indexCurrent) await writeIndex(id, listed, remote);
		const n = await deleteLater(
			id,
			extras.filter((rel) => rel !== 'index.json'),
			'unused',
			ctx
		);
		if (n) log(`  upload: ${id}: ${n} objects no uploaded page uses are to be deleted in ${Math.round(graceMs / 1000)} s`);
	}

	async function sync(id: string) {
		const [jobs, uploads] = await Promise.all([db.jobsOf(id), db.uploadsOf(target, id)]);
		const plan = planPrint(jobs, uploads);
		pendingByPrint.set(id, plan.upload.length);
		for (const k of failingPages) if (k.startsWith(`${id}\n`) && !plan.upload.some((j) => `${id}\n${j.path}` === k)) failingPages.delete(k);
		if (!hasUploadWork(plan)) return 0;
		// Just before anything goes up: a print the stage deleted is never uploaded (its pages aren't pending).
		try {
			if (opts.removed && (await opts.removed(id))) {
				pendingByPrint.set(id, 0);
				return 0;
			}
		} catch (e) {
			if (isAbort(e)) throw e;
			failed(id, null, e);
			return 1;
		}
		const listed = [...plan.listed];
		let failures = 0;
		let ctx: PrintCtx;
		try {
			const [remote, pending] = await Promise.all([remoteKeys(id), db.pendingDeletesOf(target, id)]);
			ctx = { remote, pending: new Set(pending), claims: new Map(), indexCurrent: false };
		} catch (e) {
			if (isAbort(e)) throw e;
			failed(id, null, e);
			return 1;
		}
		const pageFailed = async (job: UploadJob, e: unknown) => {
			failures++;
			failingPages.add(`${id}\n${job.path}`);
			failed(id, job.path, e);
			await db.recordFailure(target, id, job.path, message(e), now()).catch(() => undefined);
		};
		/** Pages whose files are up and that the remote index doesn't list yet. */
		const waiting: PageUp[] = [];
		let lastIndex = Date.now();
		/** The index with every waiting page, then their rows. One at a time (chained on `flushing`). */
		const flush = async () => {
			const batch = waiting.splice(0);
			if (!batch.length) return;
			lastIndex = Date.now();
			const before = new Map(listed.map((u) => [u.path, u.stamp]));
			const next = [...listed];
			for (const { row } of batch) {
				const i = next.findIndex((u) => u.path === row.path);
				if (i >= 0) next[i] = row;
				else next.push(row);
			}
			try {
				await writeIndex(id, next, ctx.remote);
			} catch (e) {
				if (isAbort(e)) throw e;
				// The bucket's index may or may not list them now: either way their rows aren't written, so they go up again.
				ctx.indexCurrent = false;
				for (const up of batch) await pageFailed(up.job, e);
				return;
			}
			listed.splice(0, listed.length, ...next);
			ctx.indexCurrent = true;
			// A few rows at a time: until they're written, a crash sends their pages again.
			let nextRow = 0;
			await allWorkers(Math.min(ROW_WRITES, batch.length), async () => {
				while (nextRow < batch.length) {
					const up = batch[nextRow++];
					try {
						await listPage(id, up, before.get(up.job.path), ctx);
						failingPages.delete(`${id}\n${up.job.path}`);
						pendingByPrint.set(id, Math.max(0, (pendingByPrint.get(id) ?? 1) - 1));
					} catch (e) {
						if (isAbort(e)) throw e;
						await pageFailed(up.job, e);
					}
				}
			});
		};
		let flushing: Promise<void> = Promise.resolve();
		let nextPage = 0;
		/** Resolved once the page before the next one to start has claimed its tiles (uploadPage). */
		let turn: Promise<void> = Promise.resolve();
		/** Another index soon; a rejection (abort) is handled here at once and thrown by `await flushing` below. */
		const flushSoon = () => {
			flushing = flushing.then(flush);
			flushing.catch(() => undefined);
		};
		try {
			await allWorkers(Math.min(opts.pageConcurrency ?? PAGE_CONCURRENCY, plan.upload.length), async () => {
				while (!stopping && !broken && nextPage < plan.upload.length) {
					const job = plan.upload[nextPage++];
					const prev = turn;
					let open!: () => void;
					turn = new Promise<void>((resolve) => (open = resolve));
					try {
						waiting.push(await uploadPage(id, job, ctx, { prev, open }));
						if (Date.now() - lastIndex >= (opts.indexEveryMs ?? INDEX_EVERY_MS)) flushSoon();
					} catch (e) {
						if (isAbort(e)) throw e;
						await pageFailed(job, e);
					}
				}
			});
		} finally {
			// Every page worker has stopped; a pending index finishes (or fails) before sync returns.
			await flushing;
		}
		// Pages up, also after a stop; after a fatal error nothing more goes, and they go up again next time.
		if (broken) return failures;
		await flush();
		if (stopping) return failures;
		try {
			if (plan.orphans.length) {
				if (!ctx.indexCurrent) await writeIndex(id, listed, ctx.remote);
				const files = plan.orphans.flatMap((u) => [
					...(u.stamp ? [overviewFile(u.path, u.stamp)] : []),
					legacyOverview(u.path),
					pageDataFile(u.path),
					sidecarFile(u.path)
				]);
				await deleteLater(
					id,
					files.filter((rel) => ctx.remote.has(`${id}/${rel}`)),
					'page removed',
					ctx
				);
				await db.forgetUploads(
					target,
					id,
					plan.orphans.map((u) => u.path)
				);
				stats.removed += plan.orphans.length;
				log(`  upload: ${id}: removed ${plan.orphans.length} pages that no longer render`);
			}
			if (!failures) await sweep(id, listed, ctx);
		} catch (e) {
			if (isAbort(e)) throw e;
			failures++;
			failed(id, null, e);
		}
		return failures;
	}

	/** Delete one print's due keys that nothing uploaded uses; drop the rows of keys used again. */
	async function deleteDue(id: string, rows: DueDelete[], tally: DeleteTally) {
		const { names, tiles, behind } = await usedKeys(
			id,
			(await db.uploadsOf(target, id)).filter((u) => u.stamp !== null)
		);
		const drop: string[] = [];
		const go: string[] = [];
		for (const r of rows) {
			const rel = r.key.slice(id.length + 1);
			if (names.has(rel) || tiles?.has(rel)) drop.push(r.key);
			else if (!tiles && rel.startsWith('t/')) tally.waiting++;
			else go.push(r.key);
		}
		if (!tiles && rows.length > drop.length + go.length)
			log(`  upload: ${id}: tiles to delete wait until page ${pageBase(behind!)} is up at the version on disk`);
		const done: string[] = [];
		// At most `concurrency` at once, each checking for a stop first (a print may have thousands of tiles to go).
		let next = 0;
		await Promise.all(
			Array.from({ length: Math.min(opts.concurrency, go.length) }, async () => {
				while (next < go.length && !stopping && !broken) {
					const key = go[next++];
					try {
						await del(key);
						done.push(key);
					} catch (e) {
						if (isAbort(e)) throw e;
						tally.failed++;
						failed(id, null, e);
					}
				}
			})
		);
		await db.dropDeletes(target, [...drop, ...done]);
		tally.deleted += done.length;
		tally.dropped += drop.length;
		stats.deletesCancelled += drop.length;
	}

	/**
	 * Delete the target's due deletions. Called as a run starts (before any print is synced) and
	 * before it exits (after the uploads): never alongside a sync, so a key can't be put and
	 * deleted at once. Pause holds it; stop and abort end it (what's left stays due).
	 */
	async function processDeletes() {
		const tally: DeleteTally = { deleted: 0, dropped: 0, waiting: 0, failed: 0 };
		const t0 = Date.now();
		try {
			const at = now();
			let after = '';
			while (!stopping && !broken) {
				const rows = await db.dueDeletes(target, at, after, DUE_BATCH);
				if (!rows.length) break;
				after = rows.at(-1)!.key;
				const byPrint = new Map<string, DueDelete[]>();
				for (const r of rows) {
					const list = byPrint.get(r.print_id);
					if (list) list.push(r);
					else byPrint.set(r.print_id, [r]);
				}
				const groups = [...byPrint];
				let next = 0;
				await Promise.all(
					Array.from({ length: Math.min(opts.concurrency, groups.length) }, async () => {
						while (next < groups.length && !stopping && !broken) {
							const [id, list] = groups[next++];
							await deleteDue(id, list, tally);
						}
					})
				);
			}
		} catch (e) {
			if (!isAbort(e)) {
				stats.lastError = `deletions: ${message(e)}`;
				log(`  upload: deletions: ${message(e)}; the next run tries again`);
			}
		}
		try {
			const c = await db.countDeletes(target);
			deletesPending = c.n;
			nextDue = c.next;
		} catch {
			// The count stays an estimate.
		}
		if (tally.deleted || tally.dropped || tally.waiting || tally.failed) {
			log(
				`upload: ${tally.deleted} objects deleted after their grace period, ${tally.dropped} kept (used again)` +
					(tally.waiting ? `, ${tally.waiting} tiles waiting for their print` : '') +
					(tally.failed ? `, ${tally.failed} failed` : '') +
					`, in ${((Date.now() - t0) / 1000).toFixed(1)} s; ${deletesPending} deletions pending`
			);
		}
		return tally;
	}

	/** The store refuses us (401, 403): no more requests this run. */
	function breakOff(msg: string, e: unknown) {
		if (broken) return;
		broken = message(e);
		stats.lastError = msg;
		settleAll();
		log(`upload: ${msg}\nupload: stopping uploads for this run; rendering goes on, and the next run uploads what's left`);
		wake();
	}

	function failed(id: string, path: string | null, e: unknown) {
		const msg = `${id}${path === null ? '' : ` ${pageBase(path)}`}: ${message(e)}`;
		if (e instanceof StoreError && e.fatal && !broken) breakOff(msg, e);
		else {
			stats.lastError = msg;
			log(`  upload failed: ${msg}`);
		}
	}

	function start(id: string) {
		queued.delete(id);
		const p = (async () => {
			try {
				const failures = await sync(id);
				if (failures) {
					const round = (rounds.get(id) ?? 0) + 1;
					rounds.set(id, round);
					if (!broken && !stopping && !(finishing && round >= maxRounds)) {
						const ms = retryDelay(round);
						timers.set(
							id,
							setTimeout(() => {
								timers.delete(id);
								schedule(id);
								checkIdle();
							}, ms)
						);
					} else if (!broken && !stopping) log(`  upload: giving up on ${id} for this run after ${round} tries; the next run tries again`);
				} else rounds.delete(id);
			} catch (e) {
				if (!isAbort(e)) failed(id, null, e);
			}
		})().finally(() => {
			running.delete(id);
			if (again.delete(id)) schedule(id);
			pump();
			notifySettled(id);
			checkIdle();
		});
		running.set(id, p);
	}

	function pump() {
		while (!stopping && !broken && queue.length && running.size < opts.concurrency) {
			const id = queue.shift()!;
			if (running.has(id)) {
				queued.delete(id);
				again.add(id);
				continue;
			}
			start(id);
		}
	}

	/** Bring the print's files in the bucket up to date, soon. `pages`: how many pages it has to upload, if known; else one more. */
	function schedule(id: string, pages?: number) {
		// Counted even after a stop: pages that finish rendering then are left for the next run.
		pendingByPrint.set(id, pages ?? (pendingByPrint.get(id) ?? 0) + 1);
		if (stopping || broken) return;
		const timer = timers.get(id);
		if (timer) {
			clearTimeout(timer);
			timers.delete(id);
		}
		if (running.has(id)) again.add(id);
		else if (!queued.has(id)) {
			queued.add(id);
			queue.push(id);
		}
		pump();
	}

	return {
		schedule,
		stats,
		/**
		 * Resolves once the print has no sync queued or running (a retry waiting on its timer doesn't
		 * count), at once after a stop or once uploads broke. Thumbnails go up after the render files this way.
		 */
		settled(id: string): Promise<void> {
			if (stopping || broken || (!queued.has(id) && !running.has(id))) return Promise.resolve();
			return new Promise((resolve) => settleWaiters.set(id, [...(settleWaiters.get(id) ?? []), resolve]));
		},
		/** Bytes/s and files/s put over the last minute, pages/s up over the last 5 minutes; null before the first request. */
		rates: () => ({ bytes: byteWindow.perSecond(), files: fileWindow.perSecond(), pages: pageWindow.perSecond() }),
		/** Rendered pages waiting to go up. */
		get pending() {
			let n = 0;
			for (const v of pendingByPrint.values()) n += v;
			return n;
		},
		processDeletes,
		/** Deletions waiting in render_deletes for the target. */
		get deletesPending() {
			return deletesPending;
		},
		get nextDue() {
			return nextDue;
		},
		/** One print's pages waiting to go up. */
		pendingOf: (id: string) => pendingByPrint.get(id) ?? 0,
		/** Every print's pages waiting to go up (read-only: the run's per-site counts). */
		pendingEntries: (): [string, number][] => [...pendingByPrint],
		/** Pages whose last upload failed, not up since. */
		get failing() {
			return failingPages.size;
		},
		/** The print of each page whose last upload failed (one entry per page). */
		failingIds: (): string[] => [...failingPages].map((k) => k.slice(0, k.indexOf('\n'))),
		get inFlight() {
			return active;
		},
		get broken() {
			return broken;
		},
		setPaused(p: boolean) {
			paused = p;
			if (!p) wake();
		},
		/** No new pages; prints finish the page they're on. */
		stop() {
			stopping = true;
			settleAll();
			for (const t of timers.values()) clearTimeout(t);
			timers.clear();
			checkIdle();
		},
		/** Cancel requests in flight too. */
		abort() {
			stopping = true;
			settleAll();
			paused = false;
			for (const t of timers.values()) clearTimeout(t);
			timers.clear();
			ac.abort();
			wake();
			checkIdle();
		},
		/** Resolves once everything scheduled is up (or given up on), or, after stop(), once the pages in flight are. */
		drain(): Promise<void> {
			finishing = true;
			if (idle()) return Promise.resolve();
			return new Promise((resolve) => idleWaiters.push(resolve));
		}
	};
}

export type Uploader = ReturnType<typeof createUploader>;

interface PrintCtx {
	/** Keys under `<id>/` in the bucket. */
	remote: Set<string>;
	/** Keys under `<id>/` waiting in render_deletes. */
	pending: Set<string>;
	/** Tiles a page in flight is sending (or will send): resolved once it is done with them, sent or not. */
	claims: Map<string, Promise<void>>;
	/** The bucket's index.json is the one the print's current `listed` makes (this sync wrote it). */
	indexCurrent: boolean;
}

/** A page whose files are up, waiting for an index that lists it before its row is written. */
interface PageUp {
	job: UploadJob;
	row: UploadRow;
	/** The overview's name in its sidecar. */
	overview: string;
	/** Tiles of the page that were up already (or sent by another page). */
	reused: number;
}

export interface DeleteTally {
	/** Objects deleted. */
	deleted: number;
	/** Pending deletions dropped because the key is in use again. */
	dropped: number;
	/** Tiles left pending because the print's uploaded tiles aren't known yet. */
	waiting: number;
	failed: number;
}
