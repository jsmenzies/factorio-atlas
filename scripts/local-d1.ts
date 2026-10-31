/**
 * The local D1's SQLite file: the one miniflare keeps for DB under `.wrangler/state`, shared by `vite dev`, render
 * runs and the update. No bun:sqlite here: the dev plugins that use it run inside Vite.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/**
 * The file under `root` (default this checkout), or null when there is none (`bun run db:migrate` makes it). With
 * `onlyOne`, a folder holding more than one database is an error rather than its first file.
 */
export function localD1File({ root = ROOT, onlyOne = false }: { root?: string; onlyOne?: boolean } = {}): string | null {
	const dir = join(root, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
	} catch {
		return null;
	}
	if (onlyOne && files.length > 1) throw new Error(`more than one D1 database in ${dir}: ${files.join(', ')}`);
	return files[0] ? join(dir, files[0]) : null;
}
