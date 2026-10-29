/**
 * A local clone of the factorioprints mirror (motlin/factorio-blueprint-firebase-cdn), e.g. from
 * `git clone --depth 1`: one JSON file per print at `<lowercase first 3 chars of id>/<id>.json`, the
 * same layout as the GitHub tree. Reading it costs nothing per record, so scripts that need every
 * record (the backfill, renders) can use it instead of fetching each one from GitHub.
 *
 * Node/Bun only (node:fs, git); never imported by the Worker.
 */
import { spawnSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { FACTORIOPRINTS_ID_PATTERN } from '#lib/print-id.js';
import { mirrorPath } from './source';

export interface CloneEntry {
	readonly id: string;
	/** Relative to the clone, e.g. `-kb/-KbXXXXXXXXXXXXXXXXX.json`. */
	readonly path: string;
	/** Bytes on disk. */
	readonly size: number;
}

export class CloneError extends Error {}

/** `<factorioprints id>.json`. */
const FILE = new RegExp(`^(${FACTORIOPRINTS_ID_PATTERN})\\.json$`);

/**
 * Every print in the clone, sorted by path (the order of the GitHub tree listing). Only shard
 * directories are read: top-level files (`firebase_cdn_watermark.txt`, `.gitattributes`) and
 * dot-directories (`.git`) are skipped, and so is any file not at its id's `mirrorPath`.
 */
export const listClone = async (dir: string): Promise<CloneEntry[]> => {
	let top;
	try {
		top = await readdir(dir, { withFileTypes: true });
	} catch (e) {
		throw new CloneError(`can't read the mirror clone at ${dir}: ${e instanceof Error ? e.message : String(e)}`);
	}
	const shards = top.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
	const perShard = await Promise.all(
		shards.map(async (shard) => {
			const files = await readdir(join(dir, shard), { withFileTypes: true });
			const entries = await Promise.all(
				files.map(async (f) => {
					const id = f.isFile() ? FILE.exec(f.name)?.[1] : undefined;
					const path = `${shard}/${f.name}`;
					if (!id || mirrorPath(id) !== path) return null;
					return { id, path, size: (await stat(join(dir, path))).size };
				})
			);
			return entries.filter((e): e is CloneEntry => e !== null);
		})
	);
	return perShard.flat().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};

/** One record's JSON text. */
export const readCloneRecord = (dir: string, entry: Pick<CloneEntry, 'path'>) => readFile(join(dir, entry.path), 'utf8');

const git = (dir: string, args: string[]) => {
	const out = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	if (out.error) throw new CloneError(`git ${args.join(' ')} in ${dir}: ${out.error.message}`);
	if (out.status !== 0) throw new CloneError(`git ${args.join(' ')} in ${dir}: ${(out.stderr ?? '').trim()}`);
	return (out.stdout ?? '').trim();
};

/**
 * The clone's commit (full sha) and whether tracked files differ from it. A clone that isn't a git
 * checkout is an error: a run's source must name the records it read.
 */
export const cloneCommit = (dir: string): { sha: string; dirty: boolean } => ({
	sha: git(dir, ['rev-parse', 'HEAD']),
	dirty: git(dir, ['status', '--porcelain', '--untracked-files=no']) !== ''
});
