/**
 * Reports (migration 0021 `reports`): what the forms send and the admin queue shows. Today only removal
 * requests about a print; the table also takes reports about an image or an account (uploads).
 * Browser-safe; the server side is src/lib/server/reports.ts.
 */

/** 'removal' (the print page's form); other kinds come later, so the column is open text. */
export type ReportKind = 'removal' | (string & {});
/** What a report is about: a print id, a screenshot's image id or a user id. */
export type SubjectKind = 'print' | 'image' | 'account';
export type ReportStatus = 'open' | 'approved' | 'rejected';

/**
 * A print id as any source makes them (factorioprints' 20 characters, `up-…`, `<site>-<id>`): letters,
 * digits, `-` and `_`. Checked before an admin action touches anything.
 */
export const isPrintIdLike = (s: string) => /^[A-Za-z0-9_-]{1,64}$/.test(s);

/** A removal request's reasons, in the form's order. */
export const REMOVAL_REASONS = {
	author: 'I made this blueprint and want it removed',
	reposted: 'This is my work, posted by someone else',
	screenshot: 'The screenshot is inappropriate or mine',
	other: 'Something else'
} as const;
export type RemovalReason = keyof typeof REMOVAL_REASONS;

export const isRemovalReason = (s: string): s is RemovalReason => Object.hasOwn(REMOVAL_REASONS, s);

/** Longest details and contact the form takes (characters). */
export const DETAILS_MAX = 2000;
export const CONTACT_MAX = 200;

/** Open reports kept per subject (per print, for removals); more are answered as received but not stored. */
export const OPEN_PER_SUBJECT_MAX = 20;

/** Days after a decision before a report's contact and details are cleared. */
export const CONTACT_KEEP_DAYS = 30;

/** How a report's `apply_error` starts when its takedown finished and only the edge-cache purge is left. */
export const PURGE_ONLY = 'purge: ';
