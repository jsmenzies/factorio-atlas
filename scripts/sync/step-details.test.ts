import { expect, test } from 'bun:test';
import type { RecordsResult } from '../records';
import type { RemovalsResult } from '../removals';
import type { RenderStages } from '#lib/render-stages.js';
import { authorsDetails, recordStoreFetch, removalsDetails, removalsSummary, renderStageDetails } from './step-details';

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

test('the render step: the run as a whole, then each source, its clean up and its search flags', () => {
	const row = { prints_total: 3, prints_rendered: 2, rendered: 12, failed: 1, uploaded: 14, uploads_pending: 0 };
	// A run that wrote no stages (it failed before its first heartbeat): only its own figures, "pages uploaded" (pages, not files).
	const old = renderStageDetails(row, null);
	expect(old.length).toBe(1);
	expect(old[0].rows.map((r) => [r.label, r.value])).toEqual([
		['prints with work', 3],
		['pages drawn', 12],
		['prints drawn', 2],
		['pages uploaded', 14],
		['failed', 1]
	]);
	const stages: RenderStages = {
		v: 1,
		at: 0,
		sites: {
			codex: {
				plan: { prints: 2, pages: 15, queued: 11, unchanged: 3, skipped: 1, failed: 0 },
				draw: { drawn: 10, failed: 1, left: 0, printsDone: 2, printsDrawn: 2 },
				upload: { pages: 12, files: 300, bytes: 9, waiting: 0, failing: 0, printsUp: 1 },
				thumbs: { done: 2, of: 2, pagesMade: 11, pagesOf: 11, waitingUpload: 1 }
			},
			upload: {
				plan: { prints: 1, pages: 2, queued: 2, unchanged: 0, skipped: 0, failed: 0 },
				draw: { drawn: 2, failed: 0, left: 0, printsDone: 1, printsDrawn: 1 },
				upload: { pages: 2, files: 40, bytes: 1, waiting: 0, failing: 0 },
				thumbs: { done: 1, of: 1 }
			}
		},
		cleanup: { state: 'done', deleted: 5, kept: 0, failed: 0, pending: 7, nextDue: null, thumbsDeleted: 1 },
		flags: { state: 'done', stage: 'prod', rowsWritten: 3, bumped: true }
	};
	const g = renderStageDetails(row, stages);
	expect(g.map((x) => x.title)).toEqual(['This run', 'Render: codex', 'Render: uploads', 'Clean up', 'Search flags on prod']);
	expect(g[1].rows.map((r) => [r.label, r.value])).toEqual([
		['prints', 2],
		['pages to draw', 11],
		['unchanged', 3],
		['skipped', 1],
		['pages drawn', 10],
		['prints drawn', '2 of 2'],
		['failed', 1],
		['pages uploaded', 12],
		['prints uploaded', '1 of 2'],
		['thumbnails', '2 of 2 prints'],
		['thumbnail pages made', '11 of 11'],
		['thumbnails waiting on upload', 1]
	]);
	// A snapshot from before printsUp: no "prints uploaded" row.
	expect(g[2].rows.map((r) => r.label)).not.toContain('prints uploaded');
	expect(g[3].rows.map((r) => [r.label, r.value])).toEqual([
		['replaced files deleted', 6],
		['still in their grace period', 7]
	]);
	expect(g[4].rows.map((r) => [r.label, r.value])).toEqual([
		['rows written', 3],
		['page cache', 'bumped']
	]);
	const failed = renderStageDetails(row, { ...stages, flags: { state: 'failed', stage: 'prod', error: 'remote /d1: lost' } });
	expect(failed.at(-1)!.rows).toEqual([{ label: 'failed', value: 'remote /d1: lost', tone: 'bad' }]);
});

test('the authors step: authors named first (the board reads it), then the lookups and writes', () => {
	const [g] = authorsDetails({ named: 6, asked: 4, prints: 9, documents: 9, rows: 18, left: 0 });
	expect(g.title).toBe('Author names');
	expect(g.rows.map((r) => [r.label, r.value])).toEqual([
		['authors named', 6],
		['asked Firebase', 4],
		['prints given a name', 9],
		['documents rewritten', 9],
		['D1 rows written', 18]
	]);
});
