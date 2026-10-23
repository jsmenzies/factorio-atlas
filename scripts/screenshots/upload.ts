/**
 * One image's files in a target bucket brought in line with the run state: a copied image's
 * sizes and original, then its manifest (last, so a page never names a file that isn't up yet); a
 * dead or removed image's manifest alone; and, once their grace period is over, the deletion of
 * files its manifest no longer uses. Every put and delete is recorded in the target's ledger.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { manifestKey, SHOT_CONTENT_TYPES, shotKeys, type Shot, type ShotManifest } from '#lib/screenshots.js';
import { withRetries, type RenderStore } from '../render/store.js';
import { applyLine, DELETE_GRACE_MS, dueDeletes, sameManifest, type Held, type LedgerLine } from './ledger.js';
import { sizePath, type Made } from './make.js';
import type { StateEntry } from './state.js';

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const MANIFEST_CACHE = 'public, max-age=300';

/** The manifest the bucket should serve for an image, or null when it has none (failed, or not made yet). */
export function wantedManifest(e: StateEntry, made: Made | null): ShotManifest | null {
	if (e.status === 'dead') return { state: 'dead' };
	if (e.status === 'removed') return { state: 'removed' };
	if (e.status === 'fetched' && made) return { state: 'copied', v: made.v, ext: made.ext, w: made.w, h: made.h };
	return null;
}

/** The keys a manifest uses (none unless copied). */
export const manifestFiles = (id: string, m: ShotManifest): string[] =>
	m.state === 'copied' ? shotKeys({ id, v: m.v, ext: m.ext, w: m.w, h: m.h } satisfies Shot) : [];

/** How long the files a manifest drops wait: none for a removal on request, else DELETE_GRACE_MS. */
export const graceFor = (e: StateEntry, graceMs = DELETE_GRACE_MS) => (e.status === 'removed' && e.by === 'request' ? 0 : graceMs);

export interface SyncContext {
	dir: string;
	store: RenderStore;
	held: Map<string, Held>;
	append: (line: LedgerLine) => void;
	now?: () => number;
	graceMs?: number;
	signal?: AbortSignal;
}

export interface SyncResult {
	put: number;
	bytes: number;
	deleted: number;
	/** The manifest was up already. */
	unchanged: boolean;
}

const contentType = (key: string) => SHOT_CONTENT_TYPES[key.slice(key.lastIndexOf('.') + 1)] ?? 'application/octet-stream';

export async function syncImage(ctx: SyncContext, e: StateEntry, made: Made | null): Promise<SyncResult | null> {
	const manifest = wantedManifest(e, made);
	if (!manifest) return null;
	const now = ctx.now ?? Date.now;
	const retry = <T>(f: () => Promise<T>) => withRetries(f, { signal: ctx.signal });
	const keys = manifestFiles(e.id, manifest);
	const held = ctx.held.get(e.id);
	const missing = keys.filter((k) => !held?.keys.has(k));
	const result: SyncResult = { put: 0, bytes: 0, deleted: 0, unchanged: true };
	if (missing.length || !sameManifest(held?.manifest, manifest)) {
		result.unchanged = false;
		const original = `${e.id}.${manifest.state === 'copied' ? manifest.ext : ''}`;
		for (const key of missing) {
			const path = key === original && e.file ? join(ctx.dir, e.file) : join(ctx.dir, sizePath(key));
			const body = new Uint8Array(await readFile(path));
			await retry(() => ctx.store.put(key, body, contentType(key), IMMUTABLE, ctx.signal));
			result.put++;
			result.bytes += body.length;
		}
		const json = new TextEncoder().encode(JSON.stringify(manifest));
		await retry(() => ctx.store.put(manifestKey(e.id), json, 'application/json', MANIFEST_CACHE, ctx.signal));
		result.put++;
		const line: LedgerLine = { id: e.id, put: missing, manifest, graceMs: graceFor(e, ctx.graceMs), at: now() };
		ctx.append(line);
		applyLine(ctx.held, line);
	}
	const h = ctx.held.get(e.id)!;
	const due = dueDeletes(h, keys, now());
	if (due.length) {
		for (const key of due) await retry(() => ctx.store.delete(key, ctx.signal));
		const line: LedgerLine = { id: e.id, deleted: due, at: now() };
		ctx.append(line);
		applyLine(ctx.held, line);
		result.deleted = due.length;
	}
	return result;
}
