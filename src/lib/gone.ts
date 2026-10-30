/**
 * The 410 answers of a print that is gone (lib/server/print-pages.ts `goneReason`): the error message says
 * which, so the error page words them apart. Browser-safe.
 */
export const GONE = {
	/** An approved removal request: tombstone 'takedown'. */
	takedown: 'Removed on request',
	/** An upload its owner deleted (or whose account was deleted): tombstone 'gone' on an `up-` print. */
	deleted: 'Deleted by its author'
} as const;
