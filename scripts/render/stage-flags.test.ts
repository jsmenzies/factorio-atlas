import { expect, test } from 'bun:test';
import { needsPageBump } from './stage-flags.js';

test('the page cache goes when an upload run replaced, removed or scheduled files for deletion', () => {
	const none = { replaced: 0, removed: 0, renderDeletes: 0, thumbDeletes: 0 };
	expect(needsPageBump(none)).toBe(false);
	expect(needsPageBump({ ...none, replaced: 1 })).toBe(true);
	expect(needsPageBump({ ...none, removed: 2 })).toBe(true);
	expect(needsPageBump({ ...none, renderDeletes: 3 })).toBe(true);
	expect(needsPageBump({ ...none, thumbDeletes: 1 })).toBe(true);
});
