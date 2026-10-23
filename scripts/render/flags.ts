/**
 * Which prints have a render in a stage's RENDERS bucket, for `bun run render:flags`
 * (scripts/render-flags.ts), from what this machine's render runs recorded: the local D1's
 * render_jobs and render_uploads (migrations 0010, 0011), read straight from its SQLite file,
 * read-only, so it works while a run or the dev server holds the database. Nothing here writes.
 *
 * A print counts when its remote index.json lists at least one page: the pages the uploader keeps
 * listed (`planPrint(...).listed` in upload.ts). For `local` the dev site also reads the renders folder (RENDERS_DIR)
 * on disk first (src/lib/server/renders.ts), so pages in a print's index.json there count too.
 */
import { Database } from 'bun:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RenderCover } from '#lib/server/pipeline/render-flags.js';
import { rendersDir, thumbsDir } from '#lib/server/renders-dir.js';
import type { RenderIndex } from '#lib/viewer/game-render.js';
import { THUMBS_INDEX, type ThumbsIndex } from '#lib/viewer/thumbs.js';
import { comparePaths } from './files.js';
import { byPrint } from './scope.js';
import { planPrint, type UploadJob, type UploadRow } from './upload.js';

const ROOT = join(import.meta.dirname, '..', '..');
export const LOCAL_D1_DIR = join(ROOT, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
export const RENDERS_DIR = rendersDir(ROOT);
export const THUMBS_DIR = thumbsDir(ROOT);

/** Pages each print has up in `target`, by print id (only prints with ≥ 1). Pure. */
export function uploadedPages(jobs: UploadJob[], uploads: UploadRow[]): Map<string, number> {
	const jobsBy = byPrint(jobs);
	const out = new Map<string, number>();
	for (const [id, ups] of byPrint(uploads)) {
		const n = planPrint(jobsBy.get(id) ?? [], ups).listed.length;
		if (n > 0) out.set(id, n);
	}
	return out;
}

/** Each print's largest page count of the sources. */
export function mergePages(...sources: Map<string, number>[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const s of sources) for (const [id, n] of s) if (n > 0) out.set(id, Math.max(out.get(id) ?? 0, n));
	return out;
}

/** The local D1's SQLite file (the one miniflare keeps for DB), or null when there is none. */
export function localD1File(dir = LOCAL_D1_DIR): string | null {
	if (!existsSync(dir)) return null;
	const files = readdirSync(dir).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
	if (files.length > 1) throw new Error(`more than one D1 database in ${dir}: ${files.join(', ')}`);
	return files[0] ? join(dir, files[0]) : null;
}

/** render_jobs and `target`'s render_uploads rows from the local D1 file, read-only. */
export function readUploads(file: string, target: string): { jobs: UploadJob[]; uploads: UploadRow[] } {
	const db = new Database(file, { readonly: true });
	try {
		db.run('PRAGMA busy_timeout = 10000');
		const tables = db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('render_jobs', 'render_uploads')`).all();
		if (tables.length < 2) throw new Error('the local D1 database has no render_jobs/render_uploads: run `bun run db:migrate`');
		const jobs = db.query('SELECT print_id, path, status, stamp, finished_at FROM render_jobs').all() as UploadJob[];
		const uploads = db.query('SELECT * FROM render_uploads WHERE target = ?').all(target) as UploadRow[];
		return { jobs, uploads };
	} finally {
		db.close();
	}
}

/** Pages in each <renders dir>/<id>/index.json (format v2), for the local stage. */
export async function diskPages(dir = RENDERS_DIR): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	if (!existsSync(dir)) return out;
	const ids = readdirSync(dir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && d.name !== 'logs')
		.map((d) => d.name);
	await Promise.all(
		ids.map(async (id) => {
			try {
				const index = JSON.parse(await readFile(join(dir, id, 'index.json'), 'utf8')) as RenderIndex;
				const n = index.v === 2 ? Object.keys(index.pages ?? {}).length : 0;
				if (n > 0) out.set(id, n);
			} catch {
				// no index (nothing rendered), or unreadable: no render on the local site either
			}
		})
	);
	return out;
}

/** A print's search-card thumbnail: its first page in book order (the render's cover) in thumbs.json, or null. Pure. */
export function coverOf(index: ThumbsIndex | null | undefined): RenderCover | null {
	const paths = Object.keys(index?.pages ?? {}).sort(comparePaths);
	if (!paths.length) return null;
	const p = index!.pages[paths[0]];
	return { page: paths[0], stamp: p.stamp, w: p.w, h: p.h };
}

/** The thumbs.json each print has in `target`'s bucket (thumb_uploads, migration 0018), from the local D1 file, read-only. */
export function readThumbUploads(file: string, target: string): Map<string, ThumbsIndex> {
	const db = new Database(file, { readonly: true });
	try {
		db.run('PRAGMA busy_timeout = 10000');
		if (!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thumb_uploads'`).get())
			throw new Error('the local D1 database has no thumb_uploads: run `bun run db:migrate`');
		const rows = db.query('SELECT print_id, thumbs FROM thumb_uploads WHERE target = ?').all(target) as {
			print_id: string;
			thumbs: string;
		}[];
		return new Map(rows.map((r) => [r.print_id, JSON.parse(r.thumbs) as ThumbsIndex]));
	} finally {
		db.close();
	}
}

/** Each print's <thumbs dir>/<id>/thumbs.json, for the local stage (the dev site reads the thumbs folder first). */
export async function diskThumbs(dir = THUMBS_DIR): Promise<Map<string, ThumbsIndex>> {
	const out = new Map<string, ThumbsIndex>();
	if (!existsSync(dir)) return out;
	const ids = readdirSync(dir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);
	await Promise.all(
		ids.map(async (id) => {
			try {
				const index = JSON.parse(await readFile(join(dir, id, THUMBS_INDEX), 'utf8')) as ThumbsIndex;
				if (index.v === 1) out.set(id, index);
			} catch {
				// no thumbnails yet
			}
		})
	);
	return out;
}

/** Each print's cover from the first source that has thumbnails for it. */
export function coversFrom(...sources: Map<string, ThumbsIndex>[]): Map<string, RenderCover> {
	const out = new Map<string, RenderCover>();
	for (const s of sources)
		for (const [id, index] of s) {
			const c = out.has(id) ? null : coverOf(index);
			if (c) out.set(id, c);
		}
	return out;
}
