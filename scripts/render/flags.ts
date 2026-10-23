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
import { rendersDir } from '#lib/server/renders-dir.js';
import type { RenderIndex } from '#lib/viewer/game-render.js';
import { byPrint } from './scope.js';
import { planPrint, type UploadJob, type UploadRow } from './upload.js';

const ROOT = join(import.meta.dirname, '..', '..');
export const LOCAL_D1_DIR = join(ROOT, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
export const RENDERS_DIR = rendersDir(ROOT);

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
