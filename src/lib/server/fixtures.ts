/**
 * Real factorioprints records for tests. They are not kept in the repo: each one is downloaded once
 * from the public GitHub mirror (motlin/factorio-blueprint-firebase-cdn) at a pinned commit, with
 * the same fields stripped as the pipeline strips (`stripPrivateFields`), and cached under
 * `.cache/fixtures/<commit>/` (gitignored). Later runs read the cache and need no network.
 *
 * `FIXTURE_BASE_URL` overrides where uncached records are fetched from.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripPrivateFields } from './pipeline/record.js';
import { mirrorPath } from './pipeline/source.js';

/** The mirror commit fixtures are read at. A fixture id must exist in the mirror at this commit. */
export const FIXTURE_COMMIT = '96d6afacef10ace4589c838bb64e39c1d0ee84c4';

const baseUrl = () =>
	process.env.FIXTURE_BASE_URL ?? `https://raw.githubusercontent.com/motlin/factorio-blueprint-firebase-cdn/${FIXTURE_COMMIT}`;

export const FIXTURE_CACHE_DIR = join(import.meta.dirname, '..', '..', '..', '.cache', 'fixtures', FIXTURE_COMMIT);

/** The sanitised `/blueprints/<id>` record as JSON text: from the cache, or downloaded and cached. */
export const fixtureRecord = async (id: string): Promise<string> => {
	const path = join(FIXTURE_CACHE_DIR, `${id}.json`);
	if (existsSync(path)) return readFileSync(path, 'utf8');
	const url = `${baseUrl()}/${mirrorPath(id)}`;
	let res: Response;
	try {
		res = await fetch(url, { headers: { 'user-agent': 'factorio-atlas tests' } });
	} catch (cause) {
		throw new Error(`fixture ${id} isn't cached in ${FIXTURE_CACHE_DIR} and ${url} couldn't be fetched`, { cause });
	}
	if (!res.ok) throw new Error(`fixture ${id}: ${url} answered HTTP ${res.status}`);
	const text = stripPrivateFields(await res.text());
	mkdirSync(FIXTURE_CACHE_DIR, { recursive: true });
	// Write then rename, so a test run killed mid-write never leaves a truncated fixture behind.
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
	return text;
};
