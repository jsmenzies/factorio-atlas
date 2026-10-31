import { expect, test } from 'bun:test';
import { FLAGS_TIMEOUT_MS, needsPageBump, withDeadline } from './stage-flags.js';

test('the page cache goes when an upload run replaced, removed or scheduled files for deletion', () => {
	const none = { replaced: 0, removed: 0, renderDeletes: 0, thumbDeletes: 0 };
	expect(needsPageBump(none)).toBe(false);
	expect(needsPageBump({ ...none, replaced: 1 })).toBe(true);
	expect(needsPageBump({ ...none, removed: 2 })).toBe(true);
	expect(needsPageBump({ ...none, renderDeletes: 3 })).toBe(true);
	expect(needsPageBump({ ...none, thumbDeletes: 1 })).toBe(true);
});

test('the --flags step gives up on a hung stage after its deadline, or at once on a stop', async () => {
	expect(FLAGS_TIMEOUT_MS).toBe(600_000);
	const hung = new Promise<never>(() => {});
	const never = new AbortController().signal;
	await expect(withDeadline(hung, 20, never)).rejects.toThrow('timed out after 0 s');
	const stop = new AbortController();
	const pending = withDeadline(hung, 60_000, stop.signal);
	stop.abort(new Error('SIGINT again'));
	await expect(pending).rejects.toThrow('abandoned: SIGINT again');
	// Finished in time: its result, or its own error.
	expect(await withDeadline(Promise.resolve({ rowsWritten: 2, bumped: true }), 1000, never)).toEqual({ rowsWritten: 2, bumped: true });
	await expect(withDeadline(Promise.reject(new Error('remote /d1')), 1000, never)).rejects.toThrow('remote /d1');
});
