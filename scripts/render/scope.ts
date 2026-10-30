/**
 * Which prints and pages the render runs cover: every print with a page saved in 2.0+, and every
 * print in render_favorites (scripts/render/favorites.ts), whose older pages are drawn too; and
 * which prints a batch (`--next`) looks at. Pure, for tests; scripts/render-game.ts applies it.
 */
import type { RenderJobRow } from '#lib/server/render-queue.js';
import { gaveUp } from './queue.js';
import { hasUploadWork, planPrint, type UploadRow } from './upload.js';

type Version = [number, number, number, number] | null;

/** Saved in 2.0 or later. */
export const isModern = (version: Version) => !!version && version[0] >= 2;

/**
 * Whether a decoded print gets rows: it has a 2.0+ page, or it is a favourite (stored, in the top
 * list now or before, whatever the run's flags). A print that doesn't is left out, and rows an
 * earlier run wrote for it are removed; a favourite's never are.
 */
export const takesPrint = (p: { modern: boolean; favorite: boolean }) => p.modern || p.favorite;

/**
 * The queueing log's "left out" part: prints taken for neither a 2.0+ page nor the favourites. Those
 * with no blueprint pages at all (books of planners) are counted on their own, as they have no
 * page of any version.
 */
export function leftOutLine(preModern: { prints: number; pages: number }, noPages: number): string {
	const old = `${preModern.prints} prints (${preModern.pages} pages) with no 2.0+ page`;
	return noPages ? `${old} and ${noPages} with no blueprint pages (planners only) left out` : `${old} left out`;
}

/** A page skipped for its version: 'pre-2.0' unless it is 2.0+ or the print is a favourite. */
export const versionSkip = (version: Version, favorite: boolean): 'pre-2.0' | null => (favorite || isModern(version) ? null : 'pre-2.0');

/**
 * A top-list print `--next --top` should look at although its stamp and rows show no work: never
 * queued as a favourite (no rows: a pre-2.0 print looked at before it was in the list), or with
 * pages an earlier run skipped as 'pre-2.0'.
 */
export const favoriteWork = (rows: Pick<RenderJobRow, 'status' | 'reason'>[] | undefined) =>
	!rows || rows.some((r) => r.status === 'skipped' && r.reason === 'pre-2.0');

/** The run's selection with `--top`'s prints first (by rank), each print once. */
export const withTopFirst = (top: string[], chosen: string[]): string[] => {
	if (!top.length) return chosen;
	const first = new Set(top);
	return [...top, ...chosen.filter((id) => !first.has(id))];
};

/** Rows grouped by print, in the order they came. */
export function byPrint<T extends { print_id: string }>(rows: Iterable<T>): Map<string, T[]> {
	const out = new Map<string, T[]>();
	for (const r of rows) {
		const list = out.get(r.print_id);
		if (list) list.push(r);
		else out.set(r.print_id, [r]);
	}
	return out;
}

export type BatchRow = Pick<RenderJobRow, 'print_id' | 'path' | 'status' | 'reason' | 'attempts' | 'stamp' | 'finished_at'>;

export interface BatchState {
	/** render_jobs rows by print. */
	rows: Map<string, BatchRow[]>;
	/** render_prints: the source stamp each print had when a run last looked at it. */
	seen: Map<string, string | null>;
	/** The source stamp of each print now. */
	stamps: Map<string, string | null>;
	/** With --upload, the target's render_uploads rows by print; null without. */
	uploads: Map<string, UploadRow[]> | null;
	/** The prints `--top` added. */
	top: readonly string[];
	retryFailed: boolean;
}

/**
 * The prints `--next` may take, in the order given: never looked at (or their record changed
 * since), or their rows have work: pages pending or rendering, failed with attempts left (any
 * failed, with --retry-failed), or with --upload rendered but not up. A print --top added counts
 * also when favoriteWork says so. `unseen`: how many of them were never looked at.
 */
export function batchCandidates(ids: readonly string[], s: BatchState): { candidates: string[]; unseen: number } {
	const rowWork = (id: string) => {
		const rows = s.rows.get(id);
		if (rows?.some((r) => r.status === 'pending' || r.status === 'rendering' || (r.status === 'failed' && (s.retryFailed || !gaveUp(r)))))
			return true;
		return !!s.uploads && hasUploadWork(planPrint(rows ?? [], s.uploads.get(id) ?? []));
	};
	const unseen = (id: string) => !s.seen.has(id) || s.seen.get(id) !== s.stamps.get(id);
	const top = new Set(s.top);
	const candidates = ids.filter((id) => unseen(id) || rowWork(id) || (top.has(id) && favoriteWork(s.rows.get(id))));
	return { candidates, unseen: candidates.filter(unseen).length };
}
