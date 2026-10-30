/**
 * A source stopped having a print (plans/ingest-and-delete, "Deletion"): the mirror lost a
 * factorioprints record, an owner deleted their upload, an account was deleted. Not a takedown: nothing
 * is blocked, and the print comes back if a source does.
 *
 * The source is marked gone (`print_sources.gone_at`). If another source is live, the print stays at its
 * URL; when the gone one was credited (the winner), the next-earliest takes over and the print is
 * ingested again from its record (`reingest`). With no live source left, the print is purged
 * (`purge`: removals' purgePrintData with kind 'gone', which leaves a tombstone and keeps the source
 * rows, marked gone) and the groups it was in are refolded (`refold`, the pipeline's `syncFold`).
 * Whenever the print stays, its document's sources list is brought up to date (`resync`).
 * Worker-safe; the stage's writes come by injection. Idempotent: whenever the print is gone at the end,
 * `refold` runs, so a call cut short between the purge and the refold is finished by running it again.
 */
import type { Site } from '#lib/print-id.js';
import { sourcesOf, winnerOf, type PrintSourceRow } from './identity-db';

export type SourceGoneResult =
	/** No such source row. */
	| { readonly status: 'unknown' }
	/** Marked gone before, and another source keeps the print. */
	| { readonly status: 'already-gone'; readonly printId: string }
	/** Another source is live and the gone one wasn't credited: nothing visible changes. */
	| { readonly status: 'kept'; readonly printId: string }
	/** The credited source went: `reingest` ran with the next-earliest, the URL unchanged. */
	| { readonly status: 'handed-over'; readonly printId: string; readonly winner: PrintSourceRow }
	/** No live source left: `purge` ran. */
	| { readonly status: 'purged'; readonly printId: string };

export interface SourceGoneDeps {
	/** Delete the print from the stage (removals' `purgePrintData(env, id, { kind: 'gone', … })`). */
	readonly purge: (printId: string) => Promise<unknown>;
	/** Ingest the print again from `winner`'s record. Needed once a print has two sources. */
	readonly reingest?: (printId: string, winner: PrintSourceRow) => Promise<unknown>;
	/**
	 * Bring the print's document's sources list up to date (the pipeline's `syncSources`), whenever the print
	 * stays: its page lists every live source, so one that went must leave it.
	 */
	readonly resync: (printId: string) => Promise<unknown>;
	/** Recompute the soft fold once the print is gone (it may have been an original, or a copy). */
	readonly refold: (printId: string) => Promise<unknown>;
	readonly now?: number;
}

const live = async (db: D1Database, printId: string) =>
	(await db.prepare('SELECT 1 AS hit FROM prints WHERE id = ?').bind(printId).first<{ hit: number }>()) !== null;

export async function sourceGone(db: D1Database, site: Site, siteId: string, deps: SourceGoneDeps): Promise<SourceGoneResult> {
	const row = await db
		.prepare('SELECT print_id, gone_at FROM print_sources WHERE site = ? AND site_id = ?')
		.bind(site, siteId)
		.first<{ print_id: string; gone_at: number | null }>();
	if (!row) return { status: 'unknown' };
	const printId = row.print_id;
	const sources = await sourcesOf(db, printId);
	const before = winnerOf(sources);
	const after = winnerOf(sources.map((s) => (s.site === site && s.site_id === siteId ? { ...s, gone_at: s.gone_at ?? 0 } : s)));
	if (row.gone_at === null) {
		await db
			.prepare('UPDATE print_sources SET gone_at = ? WHERE site = ? AND site_id = ? AND gone_at IS NULL')
			.bind(deps.now ?? Date.now(), site, siteId)
			.run();
	}
	if (!after) {
		// Also when a call was cut short: the print may still be there, or gone but not refolded.
		if (await live(db, printId)) await deps.purge(printId);
		await deps.refold(printId);
		return { status: 'purged', printId };
	}
	// Also when it was marked gone before: a call cut short before the resync is finished by running it again.
	if (row.gone_at !== null) {
		await deps.resync(printId);
		return { status: 'already-gone', printId };
	}
	if (before && before.site === site && before.site_id === siteId) {
		if (!deps.reingest) throw new Error(`${printId}: its credited source went and another is live, but no reingest was given`);
		await deps.reingest(printId, after);
		// The re-ingest's document lists the sources already, unless it changed nothing.
		await deps.resync(printId);
		return { status: 'handed-over', printId, winner: after };
	}
	await deps.resync(printId);
	return { status: 'kept', printId };
}
