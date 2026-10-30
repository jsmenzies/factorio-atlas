/**
 * Which record-store prints (other sites' and uploads, scripts/records/store.ts) a render run would draw: those
 * with a page saved in 2.0+, by id and the record file's stamp (the render queue's `render_prints.stamp`). The
 * Update tab counts those the queue hasn't looked at at that stamp (`storeWaitingStatement`,
 * src/lib/server/admin/sync.ts), so its estimate includes them: render_prints only has rows for prints a run has
 * already looked at, so the coverage figures alone never see a store print before it is drawn.
 *
 * Saved in sync_meta 'store-prints' by `sync --plan` and after an update's fetch and render steps. Decoding every
 * record takes a few seconds (783 records, 3.6 s on 2026-10-31), so each print's answer is cached by its stamp
 * in `.cache/render/`: a scan then decodes only new and changed records and stats the rest.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StorePrints } from '#lib/sync.js';
import { isModern } from './scope.js';
import { blueprintPages, decode, storeSource } from './source.js';

/** Per print: the stamp it was decoded at, and whether it has a 2.0+ page (null: unreadable). */
type Cache = { v: 1; prints: Record<string, { stamp: string; modern: boolean | null }> };

export const STORE_SCOPE_CACHE = 'store-scope.json';

const readCache = async (file: string): Promise<Cache> => {
	try {
		const c = JSON.parse(await readFile(file, 'utf8')) as Cache;
		if (c.v === 1 && c.prints && typeof c.prints === 'object') return c;
	} catch {
		// None yet, or unreadable: every record is decoded once.
	}
	return { v: 1, prints: {} };
};

/** Whether a record's string has a page saved in 2.0+; null when it can't be read. */
export const hasModernPage = async (blueprintString: string): Promise<boolean | null> => {
	try {
		return [...blueprintPages(await decode(blueprintString))].some((p) => isModern(p.version));
	} catch {
		return null;
	}
};

/** Every store print with a 2.0+ page, with its stamp; records decoded only when their stamp isn't cached. */
export async function scanStorePrints(dir: string, cacheFile: string, now = Date.now()): Promise<StorePrints & { decoded: number }> {
	const source = storeSource(dir);
	const cache = await readCache(cacheFile);
	const next: Cache = { v: 1, prints: {} };
	const out: StorePrints & { decoded: number } = { at: now, modern: [], older: 0, unreadable: 0, decoded: 0 };
	for (const id of await source.ids()) {
		const stamp = await source.stamp(id);
		if (stamp === null) continue;
		let hit = cache.prints[id];
		if (hit?.stamp !== stamp) {
			const record = await source.read(id);
			hit = { stamp, modern: record ? await hasModernPage(record.blueprintString) : null };
			out.decoded++;
		}
		next.prints[id] = hit;
		if (hit.modern) out.modern.push([id, stamp]);
		else if (hit.modern === false) out.older++;
		else out.unreadable++;
	}
	await mkdir(dirname(cacheFile), { recursive: true });
	await writeFile(`${cacheFile}.tmp`, JSON.stringify(next));
	await rename(`${cacheFile}.tmp`, cacheFile);
	return out;
}
