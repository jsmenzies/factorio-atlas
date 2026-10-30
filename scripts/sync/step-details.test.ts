import { expect, test } from 'bun:test';
import type { RecordsResult } from '../records';
import type { RemovalsResult } from '../removals';
import { recordStoreFetch, removalsDetails, removalsSummary } from './step-details';

/** The removals result of update 2026-10-30T11:44:34Z-u3og: nothing to do, 2 tombstones on prod (1 a takedown). */
const quietRemovals: RemovalsResult = {
	ok: true,
	summary: '✓ nothing to do',
	stage: 'prod',
	dryRun: false,
	stopped: false,
	deleted: 2,
	takedowns: 1,
	newlySwept: 0,
	blocksAdded: 0,
	blocksDropped: 0,
	localRows: 0,
	diskPaths: 0,
	lateRenderFiles: 0,
	screenshots: 0,
	nothingToDo: true
};

test('removals with nothing to do say so, and show the totals as totals', () => {
	expect(removalsSummary(quietRemovals)).toBe('nothing new to remove (2 removed prints so far, all swept here)');
	expect(removalsDetails(quietRemovals)).toEqual([
		{ title: 'This update', rows: [{ label: 'removed', value: 'nothing new to remove' }] },
		{
			title: 'On the site so far',
			rows: [{ label: 'removed prints', value: '2 (1 taken down on request, 1 deleted by their owner or source)' }]
		}
	]);
});

test("removals that swept a print show this run's work first", () => {
	const r: RemovalsResult = {
		...quietRemovals,
		summary: '✓ 1 deleted prints newly swept (3 in all): blocks +4/−0, 2 local rows, 1 paths on disk, 0 late render files, 0 screenshots',
		deleted: 3,
		takedowns: 2,
		newlySwept: 1,
		blocksAdded: 4,
		localRows: 2,
		diskPaths: 1,
		nothingToDo: false
	};
	expect(removalsSummary(r)).toBe(r.summary.slice(2));
	expect(removalsDetails(r)[0]).toEqual({
		title: 'This update',
		rows: [
			{ label: 'deleted prints swept for the first time', value: 1 },
			{ label: 'blocks added', value: 4 },
			{ label: 'render rows removed', value: 2 },
			{ label: 'folders removed on disk', value: 1 }
		]
	});
	expect(removalsDetails(r)[1].rows[0].value).toBe('3 (2 taken down on request, 1 deleted by their owner or source)');
});

test('a removals run that failed before reading the stage shows no total', () => {
	const r: RemovalsResult = {
		...quietRemovals,
		ok: false,
		summary: '✗ render run x is live',
		deleted: 0,
		takedowns: 0,
		nothingToDo: false
	};
	expect(removalsDetails(r)).toEqual([{ title: 'This update', rows: [{ label: 'removed', value: 'nothing' }] }]);
});

const counts = (over: Partial<RecordsResult['sites'][string]> = {}) => ({
	listed: 0,
	added: 0,
	changed: 0,
	rewritten: 0,
	removed: 0,
	unchanged: 0,
	vanished: 0,
	failed: 0,
	left: 0,
	...over
});
/** The record store in the fetch step of update 2026-10-30T11:44:34Z-u3og, before codex and fprints were admitted. */
const store: RecordsResult = {
	ok: true,
	summary: '✓ …',
	stage: 'prod',
	dir: '/home/james/data/factorio-records',
	dryRun: false,
	stopped: false,
	sites: {
		upload: counts({ listed: 1, unchanged: 1 }),
		factoriobin: counts({ listed: 1, unchanged: 1 }),
		codex: counts(),
		fprints: counts()
	},
	total: 2
};

test("the fetch step's record store leaves out polled sites it did nothing for", () => {
	const r = recordStoreFetch(store, ['codex', 'fprints']);
	expect(r.line).toBe(
		'upload: 1 on the site, 0 new, 0 changed, 0 removed · factoriobin: 1 on the site, 0 new, 0 changed, 0 removed · ' +
			'codex, fprints: in the ingest step; 2 records in the store'
	);
	expect(r.group).toEqual({
		title: 'record store',
		rows: [
			{ label: 'records', value: 2 },
			{ label: 'codex, fprints', value: 'new prints counted in the ingest step', muted: true }
		]
	});
});

test("a polled site the fetch's record store changed is named", () => {
	const r = recordStoreFetch({ ...store, sites: { ...store.sites, codex: counts({ listed: 11, removed: 1 }) } }, ['codex', 'fprints']);
	expect(r.line).toContain('codex: 11 on the site, 0 new, 0 changed, 1 removed');
	expect(r.line).toContain('fprints: in the ingest step');
	expect(r.group.rows).toEqual([
		{ label: 'records', value: 2 },
		{ label: 'removed', value: 1 },
		{ label: 'fprints', value: 'new prints counted in the ingest step', muted: true }
	]);
});
