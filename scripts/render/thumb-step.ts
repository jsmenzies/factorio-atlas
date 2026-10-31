/**
 * Thumbnails as part of `bun run render` (scripts/render-game.ts): once a print's pages are final
 * (all drawn, failed or `unchanged`), its page thumbnails are brought up to date from the overviews on
 * disk, with the same code as `bun run render:thumbs` (scripts/render/thumbs.ts), into THUMBS_DIR;
 * with `--upload`, they then go up after the print's render files (thumbs-upload.ts).
 *
 * It runs in the runner's own process, never in an fpsr worker, and only on finished overviews, so
 * it changes nothing a page's input key depends on. A few prints at a time (`concurrency`, 1 by
 * default while pages are drawn, more once drawing is over: `setConcurrency`; THUMB_STEP_MB each counts
 * against the memory budget): a decoded 2048 px overview is 16 MB, and sharp works single-threaded here,
 * so how many prints run at once never changes a byte of what is made.
 *
 * Prints whose thumbnails are up to date cost a few small reads; a page redrawn gets a new stamp and
 * so new thumbnails (the old ones are swept from disk and, uploaded, scheduled for deletion); a page
 * `unchanged` but without thumbnails gets them, so gaps fill in as runs pass over prints. A print
 * whose render went (no index.json) loses its thumbnails too.
 */
import sharp from 'sharp';
import { THUMB } from '#lib/viewer/thumbs.js';
import type { ThumbUploader } from './thumbs-upload.js';
import { finishPrint, hasThumbs, makePage, planPrint } from './thumbs.js';

/** Memory one print's thumbnails may take in the runner (a decoded overview and sharp's buffers), counted against --mem-budget-mb. */
export const THUMB_STEP_MB = 200;

export interface ThumbStepOptions {
	rendersDir: string;
	thumbsDir: string;
	/** Prints worked on at once (to start with: `setConcurrency` changes it). */
	concurrency: number;
	/** Count what would be made, make nothing. */
	planOnly: boolean;
	log: (line: string) => void;
	/** With `--upload`: the bucket's uploader, and a wait until the print's render files are up (or given up on for now). */
	upload?: { uploader: ThumbUploader; renderFilesSettled: (id: string) => Promise<void> };
	stopped: () => boolean;
	/** After each print's thumbnails are done (made and, uploading, uploaded), or given up on. */
	onPrintDone?: () => void;
}

export interface ThumbStepStats {
	/** Prints looked at, and those whose thumbnails were already up to date. */
	prints: number;
	current: number;
	/** Pages made (or, planning, to make), and how many failed. */
	pages: number;
	failed: number;
	files: number;
	bytes: number;
	/** Old thumbnails deleted from disk. */
	removed: number;
	/** Prints whose render went: their thumbnails cleared. */
	cleared: number;
	/** Time spent making thumbnails, and waiting for prints' render files to finish uploading, summed over prints (ms). */
	makingMs: number;
	waitingMs: number;
}

/**
 * One key's (site's) thumbnails: prints done of those offered, pages made of those to make (known once a print
 * is planned), prints made and waiting on their render upload, and the files of the prints uploading now (put
 * of those to put; both 0 when none is).
 */
export interface ThumbProgress {
	done: number;
	of: number;
	pagesMade: number;
	pagesOf: number;
	waitingUpload: number;
	filesUp: number;
	filesOf: number;
}

export function createThumbStep(opts: ThumbStepOptions) {
	if (!opts.planOnly) {
		// The fpsr workers have the CPU: one thread per encode here.
		sharp.concurrency(1);
		sharp.cache(false);
	}
	const stats: ThumbStepStats = {
		prints: 0,
		current: 0,
		pages: 0,
		failed: 0,
		files: 0,
		bytes: 0,
		removed: 0,
		cleared: 0,
		makingMs: 0,
		waitingMs: 0
	};
	let concurrency = Math.max(1, opts.concurrency);
	/** Pages to make and made, per print, this run (a print looked at again adds its new work). */
	const pagesOf = new Map<string, number>();
	const pagesMade = new Map<string, number>();
	/** Prints whose thumbnails are made, waiting for their render files to go up. */
	const waitingUpload = new Set<string>();
	const add = (m: Map<string, number>, id: string, n: number) => m.set(id, (m.get(id) ?? 0) + n);
	const queue: string[] = [];
	const queued = new Set<string>();
	/** Every print offered in the run, for "N of M prints". */
	const offered = new Set<string>();
	/** Prints being worked on, and those offered again meanwhile (worked on again after). */
	const working = new Set<string>();
	const again = new Set<string>();
	let active = 0;
	const idleWaiters: (() => void)[] = [];

	async function work(id: string) {
		stats.prints++;
		const plan = await planPrint(opts.rendersDir, opts.thumbsDir, id);
		if (!plan) {
			// No render (any more): thumbnails it had go.
			if (!opts.planOnly && (await hasThumbs(opts.thumbsDir, id))) {
				stats.removed += await finishPrint(opts.thumbsDir, id, [], {});
				stats.cleared++;
			} else stats.current++;
		} else if (opts.planOnly) {
			stats.pages += plan.jobs.length;
			if (!plan.rewrite) stats.current++;
			return;
		} else if (plan.rewrite) {
			const started = Date.now();
			const pages = { ...plan.kept };
			add(pagesOf, id, plan.jobs.length);
			for (const job of plan.jobs) {
				if (opts.stopped()) break;
				try {
					const r = await makePage(opts.rendersDir, opts.thumbsDir, job, THUMB);
					if (!r) continue;
					pages[job.path] = r.page;
					add(pagesMade, id, 1);
					stats.pages++;
					stats.files += r.page.sizes.length;
					stats.bytes += Object.values(r.bytes).reduce((a, b) => a + b, 0);
				} catch (e) {
					stats.failed++;
					opts.log(`  thumbnails ${id} ${job.path || 'root'}: ${e instanceof Error ? e.message : String(e)}`);
				}
			}
			if (opts.stopped()) {
				stats.makingMs += Date.now() - started;
				return;
			}
			stats.removed += await finishPrint(opts.thumbsDir, id, plan.order, pages);
			stats.makingMs += Date.now() - started;
		} else stats.current++;
		if (opts.upload && !opts.stopped()) {
			const waitFrom = Date.now();
			waitingUpload.add(id);
			try {
				await opts.upload.renderFilesSettled(id);
			} finally {
				waitingUpload.delete(id);
				stats.waitingMs += Date.now() - waitFrom;
			}
			await opts.upload.uploader.uploadPrint(id);
		}
	}

	function pump() {
		while (active < concurrency && queue.length && !opts.stopped()) {
			const id = queue.shift()!;
			queued.delete(id);
			if (working.has(id)) {
				again.add(id);
				continue;
			}
			working.add(id);
			active++;
			work(id)
				.catch((e: unknown) => opts.log(`  thumbnails ${id}: ${e instanceof Error ? e.message : String(e)}`))
				.finally(() => {
					active--;
					working.delete(id);
					if (again.delete(id) && !queued.has(id)) {
						queued.add(id);
						queue.push(id);
					}
					opts.onPrintDone?.();
					pump();
					if (!active && (!queue.length || opts.stopped())) for (const w of idleWaiters.splice(0)) w();
				});
		}
	}

	return {
		stats,
		/** Bring the print's thumbnails up to date, soon (once per print while it waits). */
		offer(id: string) {
			offered.add(id);
			if (working.has(id)) {
				again.add(id);
				return;
			}
			if (queued.has(id)) return;
			queued.add(id);
			queue.push(id);
			pump();
		},
		/** Prints waiting or being worked on. */
		get pending() {
			return queue.length + active;
		},
		/** Prints worked on at once from now on (at least 1); more start at once when there is work. */
		setConcurrency(n: number) {
			concurrency = Math.max(1, Math.floor(n));
			pump();
		},
		get concurrency() {
			return concurrency;
		},
		/** Prints offered in the run, and those of them done (none waiting or being worked on). */
		get progress(): { done: number; of: number } {
			return { done: offered.size - queue.length - active, of: offered.size };
		},
		/** `progress` split by a key of the print id (its site), with the pages and the prints waiting on their render upload. */
		progressBy<K>(keyOf: (id: string) => K): Map<K, ThumbProgress> {
			const out = new Map<K, ThumbProgress>();
			for (const id of offered) {
				const k = keyOf(id);
				let p = out.get(k);
				if (!p) out.set(k, (p = { done: 0, of: 0, pagesMade: 0, pagesOf: 0, waitingUpload: 0, filesUp: 0, filesOf: 0 }));
				p.of++;
				if (!queued.has(id) && !working.has(id)) p.done++;
				p.pagesMade += pagesMade.get(id) ?? 0;
				p.pagesOf += pagesOf.get(id) ?? 0;
				if (waitingUpload.has(id)) p.waitingUpload++;
			}
			for (const [id, f] of opts.upload?.uploader.uploading() ?? []) {
				const p = out.get(keyOf(id));
				if (!p) continue;
				p.filesUp += f.done;
				p.filesOf += f.of;
			}
			return out;
		},
		/** Resolves once every print offered is done (or, after a stop, once those in hand are). */
		drain(): Promise<void> {
			pump();
			if (!active && (!queue.length || opts.stopped())) return Promise.resolve();
			return new Promise((resolve) => idleWaiters.push(resolve));
		}
	};
}

export type ThumbStep = ReturnType<typeof createThumbStep>;
