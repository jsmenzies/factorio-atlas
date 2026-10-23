/**
 * `bun run render:thumbs --upload local|prod`: page thumbnails from the thumbs folder (THUMBS_DIR)
 * into a RENDERS bucket under the same keys, beside the renders (#lib/viewer/thumbs.ts).
 *
 * What each bucket holds is the thumbs.json last uploaded there, per print (`thumb_uploads`,
 * migration 0018, in the local D1). A print whose thumbs.json on disk equals it costs nothing;
 * otherwise the files it adds go up first, then its thumbs.json (so that never names a missing
 * file), then the files it no longer lists are scheduled for deletion in render_deletes (0012) after
 * the same grace as replaced renders (cached thumbs.json files may still name them for a minute,
 * and pages are cached longer). Due deletions of thumbnails are done as a run starts and before it
 * ends, each checked again against what the bucket's thumbs.json lists now; a key that is wanted
 * again loses its deletion row when its print is uploaded.
 *
 * The render uploader (upload.ts) never touches thumbnail keys, except that its own pass over due
 * render_deletes rows deletes those it finds due too, which is just as right.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderCacheControl } from '#lib/viewer/game-render.js';
import { THUMB_FILE, THUMBS_INDEX, thumbFile, type ThumbsIndex } from '#lib/viewer/thumbs.js';
import { StoreError, withRetries, type RenderStore } from './store.js';
import { mapPool } from './thumbs.js';

/** Every thumbnail file a thumbs.json lists, relative to its print. */
export const thumbKeys = (index: ThumbsIndex | null): Set<string> =>
	new Set(Object.entries(index?.pages ?? {}).flatMap(([path, p]) => p.sizes.map((t) => thumbFile(path, p.stamp, t))));

export interface ThumbUploadPlan {
	/** Nothing to do: the bucket has this thumbs.json already. */
	unchanged: boolean;
	/** Files to put, relative to the print, in thumbs.json's order. */
	put: string[];
	/** Files the bucket has that the new thumbs.json no longer lists. */
	remove: string[];
	/** The thumbs.json to put after the files (an empty one when the print has none on disk any more). */
	index: ThumbsIndex;
}

/** What to do to bring the bucket's thumbnails of one print from `uploaded` to `local`. Pure. */
export function planThumbUpload(local: ThumbsIndex | null, uploaded: ThumbsIndex | null): ThumbUploadPlan {
	const index = local ?? { v: 1, pages: {} };
	const unchanged = uploaded !== null && JSON.stringify(index) === JSON.stringify(uploaded);
	const want = thumbKeys(index);
	const have = thumbKeys(uploaded);
	return {
		unchanged: unchanged || (local === null && uploaded === null),
		put: unchanged ? [] : [...want].filter((k) => !have.has(k)),
		remove: unchanged ? [] : [...have].filter((k) => !want.has(k)),
		index
	};
}

/** The tables the uploader uses in the local D1. */
export interface ThumbUploadDb {
	uploaded(target: string): Promise<Map<string, ThumbsIndex>>;
	saveUploaded(target: string, id: string, index: ThumbsIndex, at: number): Promise<void>;
	/** render_deletes: a key already waiting keeps its time. */
	scheduleDeletes(target: string, id: string, keys: string[], notBefore: number, at: number): Promise<void>;
	/** Drop the deletion rows of keys that are wanted again. */
	cancelDeletes(target: string, keys: string[]): Promise<void>;
	/** Due render_deletes rows of thumbnail files. */
	dueThumbDeletes(target: string, at: number): Promise<{ key: string; print_id: string }[]>;
}

const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export function thumbUploadDb(db: D1Database): ThumbUploadDb {
	return {
		async uploaded(target) {
			const { results } = await db
				.prepare('SELECT print_id, thumbs FROM thumb_uploads WHERE target = ?')
				.bind(target)
				.all<{ print_id: string; thumbs: string }>();
			return new Map(results.map((r) => [r.print_id, JSON.parse(r.thumbs) as ThumbsIndex]));
		},
		async saveUploaded(target, id, index, at) {
			await db
				.prepare(
					`INSERT INTO thumb_uploads (target, print_id, thumbs, uploaded_at) VALUES (?, ?, ?, ?)
					ON CONFLICT (target, print_id) DO UPDATE SET thumbs = excluded.thumbs, uploaded_at = excluded.uploaded_at`
				)
				.bind(target, id, JSON.stringify(index), at)
				.run();
		},
		async scheduleDeletes(target, id, keys, notBefore, at) {
			const stmts = chunks(keys, 16).map((c) =>
				db
					.prepare(
						`INSERT INTO render_deletes (target, key, print_id, not_before, reason, queued_at) VALUES ${c.map(() => "(?, ?, ?, ?, 'thumbnail replaced', ?)").join(', ')}
						ON CONFLICT (target, key) DO NOTHING`
					)
					.bind(...c.flatMap((k) => [target, k, id, notBefore, at]))
			);
			if (stmts.length) await db.batch(stmts);
		},
		async cancelDeletes(target, keys) {
			const stmts = chunks(keys, 90).map((c) =>
				db.prepare(`DELETE FROM render_deletes WHERE target = ? AND key IN (${c.map(() => '?').join(', ')})`).bind(target, ...c)
			);
			if (stmts.length) await db.batch(stmts);
		},
		async dueThumbDeletes(target, at) {
			const { results } = await db
				.prepare(`SELECT key, print_id FROM render_deletes WHERE target = ? AND not_before <= ? AND key LIKE '%.t%.avif'`)
				.bind(target, at)
				.all<{ key: string; print_id: string }>();
			return results.filter((r) => THUMB_FILE.test(r.key.slice(r.print_id.length + 1)));
		}
	};
}

export interface ThumbUploadStats {
	prints: number;
	unchanged: number;
	/** Prints with no thumbs.json on disk and none uploaded. */
	missing: number;
	uploaded: number;
	files: number;
	bytes: number;
	deletesScheduled: number;
	deleted: number;
	kept: number;
	failed: number;
}

export interface ThumbUploaderOptions {
	store: RenderStore;
	db: ThumbUploadDb;
	target: string;
	/** The thumbs folder (THUMBS_DIR). */
	dir: string;
	graceMs: number;
	concurrency?: number;
	now?: () => number;
	log?: (line: string) => void;
	/** Checked between prints and files: true stops the uploader (what's left goes up next time). */
	stopped?: () => boolean;
}

const readIndex = async (file: string): Promise<ThumbsIndex | null> => {
	try {
		const index = JSON.parse(await readFile(file, 'utf8')) as ThumbsIndex;
		return index.v === 1 ? index : null;
	} catch {
		return null;
	}
};

/**
 * Uploads prints' thumbnails one print at a time (`uploadPrint`), and deletes due ones
 * (`processDue`, run it before the first print and after the last). Used by
 * `render:thumbs --upload` and by `bun run render --upload` after a print's render files.
 */
export async function createThumbUploader(opts: ThumbUploaderOptions) {
	const { store, db, target, dir } = opts;
	const now = opts.now ?? Date.now;
	const log = opts.log ?? console.log;
	const stopped = opts.stopped ?? (() => false);
	const stats: ThumbUploadStats = {
		prints: 0,
		unchanged: 0,
		missing: 0,
		uploaded: 0,
		files: 0,
		bytes: 0,
		deletesScheduled: 0,
		deleted: 0,
		kept: 0,
		failed: 0
	};
	const uploaded = await db.uploaded(target);
	/** Set when the store refuses us (401, 403): the remaining prints are left for the next run. */
	let broken: string | null = null;

	/** Delete due thumbnail keys that the bucket's thumbs.json doesn't list; drop the rows of those it does. */
	const processDue = async () => {
		if (broken) return;
		const due = await db.dueThumbDeletes(target, now());
		const keep: string[] = [];
		const gone: string[] = [];
		await mapPool(due, opts.concurrency ?? 8, async (r) => {
			if (thumbKeys(uploaded.get(r.print_id) ?? null).has(r.key.slice(r.print_id.length + 1))) {
				keep.push(r.key);
				return;
			}
			if (stopped()) return;
			try {
				await withRetries(() => store.delete(r.key));
				gone.push(r.key);
			} catch (e) {
				stats.failed++;
				log(`  ${r.key}: delete failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		});
		await db.cancelDeletes(target, [...keep, ...gone]);
		stats.deleted += gone.length;
		stats.kept += keep.length;
	};

	/** Bring one print's thumbnails in the bucket in line with its thumbs.json on disk. False when it failed. */
	const uploadPrint = async (id: string): Promise<boolean> => {
		if (broken || stopped()) return false;
		stats.prints++;
		const local = await readIndex(join(dir, id, THUMBS_INDEX));
		const plan = planThumbUpload(local, uploaded.get(id) ?? null);
		if (plan.unchanged) {
			if (local === null) stats.missing++;
			else stats.unchanged++;
			return true;
		}
		try {
			// Keys wanted again must not be deleted by a deletion queued earlier.
			await db.cancelDeletes(
				target,
				[...thumbKeys(plan.index)].map((k) => `${id}/${k}`)
			);
			for (const rel of plan.put) {
				if (stopped()) return false;
				const body = new Uint8Array(await readFile(join(dir, id, rel)));
				await withRetries(() => store.put(`${id}/${rel}`, body, 'image/avif', renderCacheControl(rel)));
				stats.files++;
				stats.bytes += body.byteLength;
			}
			const json = new TextEncoder().encode(JSON.stringify(plan.index));
			await withRetries(() => store.put(`${id}/${THUMBS_INDEX}`, json, 'application/json', renderCacheControl(THUMBS_INDEX)));
			const t = now();
			if (plan.remove.length) {
				await db.scheduleDeletes(
					target,
					id,
					plan.remove.map((k) => `${id}/${k}`),
					t + opts.graceMs,
					t
				);
				stats.deletesScheduled += plan.remove.length;
			}
			await db.saveUploaded(target, id, plan.index, t);
			uploaded.set(id, plan.index);
			stats.uploaded++;
			return true;
		} catch (e) {
			stats.failed++;
			log(`  thumbnails ${id}: ${e instanceof Error ? e.message : String(e)}`);
			if (e instanceof StoreError && e.fatal) broken = e.message;
			return false;
		}
	};

	return {
		stats,
		processDue,
		uploadPrint,
		get broken() {
			return broken;
		}
	};
}

export type ThumbUploader = Awaited<ReturnType<typeof createThumbUploader>>;

/** `render:thumbs --upload`: every print in `ids`, `concurrency` at a time, due deletions before and after. */
export async function uploadThumbs(opts: ThumbUploaderOptions & { ids: string[] }): Promise<ThumbUploadStats> {
	const up = await createThumbUploader(opts);
	await up.processDue();
	await mapPool(opts.ids, opts.concurrency ?? 8, async (id) => {
		await up.uploadPrint(id);
		if (up.stats.prints % 100 === 0) (opts.log ?? console.log)(`${up.stats.prints} of ${opts.ids.length} prints`);
	});
	await up.processDue();
	return up.stats;
}
