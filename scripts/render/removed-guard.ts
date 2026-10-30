/**
 * Never upload a deleted print's render files or thumbnails. A print the upload target's stage has
 * deleted (a `print_tombstones` row of either kind: taken down, or gone, e.g. an upload its owner deleted)
 * or blocked (`removal_blocks` kind 'print') is skipped and logged, whether the run is hand-run or the
 * update's. The site Worker already deleted its files from RENDERS; putting them back would leave
 * orphans that only `bun run removals` might find.
 *
 * The stage's deleted prints are read once per run (one query), and each print is checked again just
 * before its upload (one indexed lookup), since a delete can land mid-run. A print found deleted stays
 * deleted for the rest of the run. A failed check throws: the uploader counts it as a failed sync and
 * tries again later, never uploading unchecked.
 */
export const REMOVED_ALL_SQL = `SELECT print_id AS id FROM print_tombstones UNION SELECT value AS id FROM removal_blocks WHERE kind = 'print'`;
export const REMOVED_ONE_SQL = `SELECT EXISTS (SELECT 1 FROM print_tombstones WHERE print_id = ?1)
	OR EXISTS (SELECT 1 FROM removal_blocks WHERE kind = 'print' AND value = ?1) AS hit`;

export interface RemovedGuard {
	/** Whether `id` is deleted or blocked on the stage now. */
	removed(id: string): Promise<boolean>;
	/** Prints skipped so far (each logged once). */
	readonly skipped: ReadonlySet<string>;
}

export async function removedGuard(db: D1Database, log: (line: string) => void = () => undefined): Promise<RemovedGuard> {
	const known = new Set((await db.prepare(REMOVED_ALL_SQL).all<{ id: string }>()).results.map((r) => r.id));
	const skipped = new Set<string>();
	const skip = (id: string) => {
		if (!skipped.has(id)) log(`  ${id}: deleted or removed on the upload target's site: not uploaded`);
		skipped.add(id);
		return true;
	};
	return {
		skipped,
		async removed(id) {
			if (known.has(id)) return skip(id);
			const row = await db.prepare(REMOVED_ONE_SQL).bind(id).first<{ hit: number }>();
			if (!row?.hit) return false;
			known.add(id);
			return skip(id);
		}
	};
}
