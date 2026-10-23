/**
 * What each target bucket holds: `uploads/<target>.jsonl` in the screenshots folder, appended to
 * as files go up and are deleted, never rewritten; per image, the last manifest uploaded and every
 * key ever put there. `screenshots:flags` reads it to set the stage's `screenshots` table, and an
 * upload compares the manifest it would write with the last one, so an unchanged image costs no
 * request. Pure, for tests.
 */
import type { ShotManifest } from '#lib/screenshots.js';

export const UPLOAD_TARGETS = ['local', 'prod'] as const;
export type UploadTarget = (typeof UPLOAD_TARGETS)[number];

export const ledgerFile = (target: UploadTarget) => `uploads/${target}.jsonl`;

/** Files a replaced or removed image no longer uses wait this long before they are deleted (cached pages may still name them). */
export const DELETE_GRACE_MS = 25 * 3600_000;

export type LedgerLine =
	/** These keys were put, then the manifest: from `at` on, the bucket serves `manifest`. `graceMs`: how long keys it no longer uses wait. */
	| { id: string; put: string[]; manifest: ShotManifest; graceMs: number; at: number }
	/** These keys were deleted. */
	| { id: string; deleted: string[]; at: number };

export interface Held {
	/** The last manifest uploaded. */
	manifest: ShotManifest;
	/** When it went up, and how long the keys it doesn't use wait. */
	at: number;
	graceMs: number;
	/** Keys in the bucket now (put and not deleted since). */
	keys: Set<string>;
}

/** Bring `held` up to date with one ledger line. */
export function applyLine(held: Map<string, Held>, l: LedgerLine) {
	const h = held.get(l.id);
	if ('deleted' in l) {
		for (const k of l.deleted) h?.keys.delete(k);
		return;
	}
	const keys = h?.keys ?? new Set<string>();
	for (const k of l.put) keys.add(k);
	held.set(l.id, { manifest: l.manifest, at: l.at, graceMs: l.graceMs, keys });
}

/** Per image id, what the bucket holds; lines that don't parse are skipped and counted. */
export function readLedger(text: string): { held: Map<string, Held>; bad: number } {
	const held = new Map<string, Held>();
	let bad = 0;
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try {
			const l = JSON.parse(line) as LedgerLine;
			if (typeof l?.id !== 'string' || !(('deleted' in l && Array.isArray(l.deleted)) || ('manifest' in l && Array.isArray(l.put))))
				throw new Error('not a ledger line');
			applyLine(held, l);
		} catch {
			bad++;
		}
	}
	return { held, bad };
}

export const formatLine = (l: LedgerLine) => `${JSON.stringify(l)}\n`;

export const sameManifest = (a: ShotManifest | undefined, b: ShotManifest) => !!a && JSON.stringify(a) === JSON.stringify(b);

/**
 * Keys in the bucket that the image's current manifest doesn't use (`wanted`), once the manifest has
 * been up for its grace period; an empty list before that.
 */
export function dueDeletes(h: Held, wanted: readonly string[], now: number): string[] {
	if (now - h.at < h.graceMs) return [];
	const keep = new Set(wanted);
	return [...h.keys].filter((k) => !keep.has(k)).sort();
}
