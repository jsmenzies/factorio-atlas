/**
 * The upload queue of `bun run render --upload local|prod`: puts rendered pages into a RENDERS
 * bucket (store.ts) while the run goes on rendering, so each finished page appears on the site that
 * reads that bucket.
 *
 * The unit of work is a print: syncing one brings the bucket in line with its render_jobs rows.
 * Per page, in this order: its tiles not in the bucket yet, `<page>.<stamp>.avif`, `<page>.page.json`,
 * `<page>.json` (the sidecar), then the print's `index.json` rebuilt from the pages whose files are
 * up, then (scheduling a re-rendered page's previous overview for deletion) its render_uploads row. Every object
 * gets the Cache-Control of renderCacheControl (#lib/viewer/game-render.js): images for good,
 * index.json a minute, sidecars and page data five minutes. So:
 * - The remote index never lists a page whose files aren't all there. A page being re-rendered
 *   stays listed at the version that is up until its new files are.
 * - A run killed at any point repeats at most the page that was going up: its row is written
 *   last, and tiles are checked against the bucket's own listing (one LIST per print, cached), so
 *   tiles that made it up are not sent again.
 * - Pages of one print go up one at a time (their tiles in parallel); prints in parallel. At most
 *   `concurrency` requests are in flight. Pause holds new requests; stop finishes the page each
 *   print is on; abort cancels the requests in flight (those pages go up next time).
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
/** Due deletions read per query. */
const DUE_BATCH = 1000;
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
		while (paused || active >= opts.concurrency) {
			ac.signal.throwIfAborted();
			await new Promise<void>((resolve) => (urgent ? slotWaiters.unshift(resolve) : slotWaiters.push(resolve)));
		}
		ac.signal.throwIfAborted();
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

	/** One store call: a request slot, retries, abort. */
	async function request<T>(what: string, f: (signal: AbortSignal) => Promise<T>, urgent = true): Promise<T> {
		await acquire(urgent);
		byteWindow.start();
		fileWindow.start();
		pageWindow.start();
		try {
			return await withRetries(() => f(ac.signal), {
				...opts.retry,
				signal: ac.signal,
				onRetry: (e, attempt, ms) => {
					stats.lastError = e.message;
					log(`  upload: ${what}: ${e.message}; retry ${attempt} in ${(ms / 1000).toFixed(1)} s`);
				}
			});
		} finally {
			release();
		}
	}

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
		await db.dropDeletes(target, hit);
		for (const k of hit) ctx.pending.delete(k);
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

	/** One page up, then the index, then its row. Returns the new row. */
	async function uploadPage(id: string, job: UploadJob, listed: UploadRow[], ctx: PrintCtx): Promise<UploadRow> {
		const { remote } = ctx;
		const dir = join(opts.outDir, id);
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
		const hashes = [...new Set(sc.levels.flatMap((l) => l.tiles).filter(Boolean))];
		await cancelDeletes(
			[sc.overview.file, pageDataFile(job.path), sidecarFile(job.path), ...hashes.map(tileHashFile)].map((rel) => `${id}/${rel}`),
			ctx
		);
		const missing = hashes.filter((h) => !remote.has(`${id}/${tileHashFile(h)}`));
		let files = 0;
		let bytes = 0;
		let failure: unknown = null;
		// At most `concurrency` tiles of a page queued at once: a page with thousands of tiles doesn't
		// hold every file read in memory, and other prints' tiles take turns with it.
		let nextTile = 0;
		await Promise.all(
			Array.from({ length: Math.min(opts.concurrency, missing.length) }, async () => {
				while (!failure && nextTile < missing.length) {
					const h = missing[nextTile++];
					try {
						const body = await readBody(join(dir, tileHashFile(h)));
						if (failure) return;
						await put(id, tileHashFile(h), body, 'image/avif', remote);
						files++;
						bytes += body.byteLength;
					} catch (e) {
						failure ??= e;
					}
				}
			})
		);
		if (failure) throw failure;
		for (const [rel, type] of [
			[sc.overview.file, 'image/avif'],
			[pageDataFile(job.path), 'application/json']
		] as const) {
			const body = await readBody(join(dir, rel));
			await put(id, rel, body, type, remote);
			files++;
			bytes += body.byteLength;
		}
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
		await writeIndex(id, [...listed.filter((u) => u.path !== job.path), row], remote);
		// The index no longer names the page's previous overview (or one from before stamps), but a
		// cached sidecar may: it goes after the grace period.
		const before = listed.find((u) => u.path === job.path)?.stamp;
		await deleteLater(
			id,
			[before ? overviewFile(job.path, before) : null, legacyOverview(job.path)].filter(
				(rel): rel is string => !!rel && rel !== sc.overview.file && remote.has(`${id}/${rel}`)
			),
			'replaced',
			ctx
		);
		await db.recordUpload(row);
		stats.pages++;
		pageWindow.add(1);
		stats.files += files;
		stats.bytes += bytes;
		stats.reused += hashes.length - missing.length;
		log(`  ↑ ${id} ${pageBase(job.path).padEnd(6)} ${files} files, ${mb(bytes)} (${hashes.length - missing.length} tiles already up)`);
		return row;
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
		await writeIndex(id, listed, remote);
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
		const listed = [...plan.listed];
		let failures = 0;
		let ctx: PrintCtx;
		try {
			const [remote, pending] = await Promise.all([remoteKeys(id), db.pendingDeletesOf(target, id)]);
			ctx = { remote, pending: new Set(pending) };
		} catch (e) {
			if (isAbort(e)) throw e;
			failed(id, null, e);
			return 1;
		}
		for (const job of plan.upload) {
			if (stopping || broken) return failures;
			try {
				const row = await uploadPage(id, job, listed, ctx);
				const i = listed.findIndex((u) => u.path === job.path);
				if (i >= 0) listed[i] = row;
				else listed.push(row);
				failingPages.delete(`${id}\n${job.path}`);
				pendingByPrint.set(id, Math.max(0, (pendingByPrint.get(id) ?? 1) - 1));
			} catch (e) {
				if (isAbort(e)) throw e;
				failures++;
				failingPages.add(`${id}\n${job.path}`);
				failed(id, job.path, e);
				await db.recordFailure(target, id, job.path, message(e), now()).catch(() => undefined);
				if (broken) return failures;
			}
		}
		if (stopping || broken) return failures;
		try {
			if (plan.orphans.length) {
				await writeIndex(id, listed, ctx.remote);
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

	function failed(id: string, path: string | null, e: unknown) {
		const msg = `${id}${path === null ? '' : ` ${pageBase(path)}`}: ${message(e)}`;
		stats.lastError = msg;
		if (e instanceof StoreError && e.fatal && !broken) {
			broken = message(e);
			settleAll();
			log(`upload: ${msg}\nupload: stopping uploads for this run; rendering goes on, and the next run uploads what's left`);
			wake();
		} else log(`  upload failed: ${msg}`);
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
		/** Pages whose last upload failed, not up since. */
		get failing() {
			return failingPages.size;
		},
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
