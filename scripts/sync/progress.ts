/**
 * A step's live progress for the Update tab, as typed events (#lib/sync-progress.js): one JSON line each,
 * appended to the progress file the update names in SYNC_PROGRESS_ENV. A script run on its own has none, and
 * writes nothing. Never throws: progress is for display only.
 */
import { appendFileSync } from 'node:fs';
import { SYNC_PROGRESS_ENV, type ProgressEvent } from '#lib/sync-progress.js';

export function progress(event: ProgressEvent) {
	const file = process.env[SYNC_PROGRESS_ENV];
	if (!file) return;
	try {
		appendFileSync(file, `${JSON.stringify(event)}\n`);
	} catch {
		// The Update tab's live counts miss one: the step's own result is unaffected.
	}
}
