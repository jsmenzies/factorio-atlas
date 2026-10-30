/**
 * Adding a print by its link on another site (/admin/add, `bun run add`): the one result shape both
 * paths answer with, and its one-line summary. Browser-safe (types only from the server modules).
 */
import type { AddPostResult } from '#lib/server/pipeline/factoriobin.js';

/** What /admin/add shows: the Worker action's answer, or `bun run add --json`'s last line under `vite dev`. */
export type AddView = {
	/** The stage the print went to: the Worker's own (null), or the command's `--stage`. */
	stage: string | null;
	link: string;
	/** Where the record store took the print ('new' | 'changed' | 'same'), or null (not stored; the Worker never does). */
	stored: string | null;
	summary: string;
} & (AddPostResult | { ok: false; problem: 'error'; message: string });

const kb = (bytes: number) => `${Math.round(bytes / 1024).toLocaleString('en-US')} KB`;
const count = (x: number) => x.toLocaleString('en-US');

/** One line for a result: ✓ when the gate answered (refusals too), ✗ when the post couldn't be read or the add failed. */
export const summaryOf = (r: AddPostResult): string => {
	if (!r.ok) return `✗ ${r.message}`;
	const x = r.result;
	const would = x.planned;
	switch (x.status) {
		case 'new':
			return `✓ ${would ? 'would be added as' : 'added as'} ${x.printId}`;
		case 'joins':
			return `✓ ${would ? 'would join' : 'joined'} ${x.printId}, the same blueprint, as another source${x.shown ? ' (shown now: posted first)' : ''}`;
		case 'already':
			return `✓ already here as ${x.printId}`;
		case 'blocked':
			return `✓ refused: an approved removal blocks it (by ${x.by})`;
		case 'unreadable':
			return `✓ refused: the string can't be read (${x.reason})`;
		case 'too-big':
			return x.by === 'string'
				? `✓ too big here: ${kb(x.size)} of string, over ${kb(x.limit)}`
				: `✓ too big here: ${count(x.size)} entities and tiles, over ${count(x.limit)}`;
		case 'failed':
			return `✗ failed: ${x.reason}`;
	}
};
