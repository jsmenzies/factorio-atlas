import { describe, expect, test } from 'bun:test';
import { parseStages, stageSite, stageTotals } from '#lib/render-stages.js';
import { snapshot, stageTally, type PageCount, type RunPageCounts } from './stages.js';

const FP = '-LI0gc-a-2_VLWR-tx1d';
const FP2 = '-KYpTULTDIvDOsJfgjeS';
const CODEX = 'codex-230';
const FPRINTS = 'fprints-a987c20d';

/** A run of three prints: what the runner would count, page by page. */
function run() {
	const tally = stageTally();
	// factorioprints: 3 pages, 1 unchanged, 1 skipped, 1 queued and drawn; a second print all unchanged.
	tally.page(FP, 'unchanged');
	tally.page(FP, 'skipped');
	tally.page(FP, 'queued');
	tally.page(FP, 'drawn');
	tally.page(FP2, 'unchanged');
	// codex: 4 queued, 2 drawn, 1 failed in drawing, 1 left (a stop); 1 failed at queueing (gave up before).
	for (let i = 0; i < 4; i++) tally.page(CODEX, 'queued');
	tally.page(CODEX, 'drawn');
	tally.page(CODEX, 'drawn');
	tally.page(CODEX, 'drawFailed');
	tally.page(CODEX, 'planFailed');
	// fprints: one page queued, drawn and uploaded; codex's two up too, and one earlier page caught up.
	tally.page(FPRINTS, 'queued');
	tally.page(FPRINTS, 'drawn');
	tally.up(FP, 20, 2000);
	tally.up(CODEX, 10, 1000);
	tally.up(CODEX, 12, 1200);
	tally.up(FPRINTS, 5, 500);
	return tally;
}

const snap = (o: Partial<Parameters<typeof snapshot>[0]> = {}) =>
	snapshot({
		at: 1,
		tally: run(),
		tracked: [FP, CODEX, FPRINTS],
		finished: [FP, FPRINTS],
		drawnPrints: [FP, CODEX, FPRINTS],
		upload: {
			waiting: [
				[CODEX, 1],
				[FP2, 0]
			],
			failing: [CODEX]
		},
		thumbs: new Map([
			['factorioprints', { done: 1, of: 1 }],
			['fprints', { done: 0, of: 1 }]
		]),
		cleanup: { state: 'done', deleted: 3, kept: 1, failed: 0, pending: 2, nextDue: null, thumbsDeleted: 0 },
		flags: { state: 'done', stage: 'local', rowsWritten: 4, bumped: true },
		...o
	});

describe('render stages per source', () => {
	test('stageSite: factorioprints ids, prefixed ids, else other', () => {
		expect(stageSite(FP)).toBe('factorioprints');
		expect(stageSite(CODEX)).toBe('codex');
		expect(stageSite('up-abcdefghij')).toBe('upload');
		expect(stageSite('nonsense')).toBe('other');
	});

	test('plan and draw: pages by what became of them, left = queued less drawn and failed', () => {
		const s = snap();
		expect(s.sites.factorioprints).toMatchObject({
			plan: { prints: 1, pages: 4, queued: 1, unchanged: 2, skipped: 1, failed: 0 },
			draw: { drawn: 1, failed: 0, left: 0, printsDone: 1, printsDrawn: 1 },
			upload: { pages: 1, files: 20, bytes: 2000, waiting: 0, failing: 0, printsUp: 1 },
			thumbs: { done: 1, of: 1 }
		});
		expect(s.sites.codex).toMatchObject({
			plan: { prints: 1, pages: 5, queued: 4, failed: 1 },
			draw: { drawn: 2, failed: 1, left: 1, printsDone: 0, printsDrawn: 1 },
			upload: { pages: 2, files: 22, bytes: 2200, waiting: 1, failing: 1, printsUp: 0 },
			// The thumb step had nothing of codex's yet.
			thumbs: { done: 0, of: 0 }
		});
		expect(s.sites.fprints?.thumbs).toEqual({ done: 0, of: 1 });
		expect(s.cleanup?.deleted).toBe(3);
		expect(s.flags).toMatchObject({ state: 'done', rowsWritten: 4 });
	});

	test('printsUp: finished prints with no page waiting or failing', () => {
		const FP3 = '-KnQ865j-qQ21WoUPbd3';
		const s = snap({
			tracked: [FP, FP2, FP3, CODEX],
			finished: new Set([FP, FP2, FP3, CODEX]),
			upload: {
				waiting: [
					[FP2, 2],
					[FP3, 0]
				],
				failing: [CODEX]
			}
		});
		// FP and FP3 are up (FP3's waiting count is 0); FP2 still has pages waiting; codex has one failing.
		expect(s.sites.factorioprints?.upload?.printsUp).toBe(2);
		expect(s.sites.factorioprints?.draw.printsDone).toBe(3);
		expect(s.sites.codex?.upload?.printsUp).toBe(0);
		// A print not finished drawing isn't up, whatever its uploads.
		expect(snap({ finished: [] }).sites.fprints?.upload?.printsUp).toBe(0);
	});

	test('the sites add up', () => {
		const s = snap();
		expect(stageTotals(s)).toMatchObject({ pages: 10, queued: 6, drawn: 4, failed: 2, uploaded: 4, thumbsDone: 1, thumbsOf: 2 });
		expect(stageTally().runCounts()).toEqual({ total: 0, done: 0, rendered: 0, unchanged: 0, skipped: 0, failed: 0 });
	});

	test('no upload, no thumbnails: those stages are null', () => {
		const s = snap({ upload: null, thumbs: null, cleanup: null, flags: null });
		expect(s.sites.codex?.upload).toBeNull();
		expect(s.sites.codex?.thumbs).toBeNull();
	});

	test('the run row’s page columns from the tally equal the counters the runner used to keep beside it', () => {
		// The run.* increments that went with each tally call in scripts/render-game.ts before the columns were derived.
		const old: Record<PageCount, (keyof RunPageCounts)[]> = {
			planFailed: ['total', 'done', 'failed'],
			skipped: ['total', 'done', 'skipped'],
			unchanged: ['total', 'done', 'unchanged'],
			queued: ['total'],
			drawn: ['done', 'rendered'],
			drawFailed: ['done', 'failed']
		};
		const kinds = Object.keys(old) as PageCount[];
		const ids = [FP, FP2, CODEX, FPRINTS, 'fbin-abc123', 'up-AbCdEf1234', 'nobody-knows'];
		let seed = 12345;
		const rand = (n: number) => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			return seed % n;
		};
		for (let sequence = 0; sequence < 500; sequence++) {
			const tally = stageTally();
			const counters: RunPageCounts = { total: 0, done: 0, rendered: 0, unchanged: 0, skipped: 0, failed: 0 };
			const steps = rand(400);
			for (let i = 0; i < steps; i++) {
				const what = kinds[rand(kinds.length)];
				tally.page(ids[rand(ids.length)], what);
				for (const c of old[what]) counters[c]++;
				if (rand(7) === 0) tally.up(ids[rand(ids.length)], rand(50), rand(5000));
				if (rand(50) === 0) expect(tally.runCounts()).toEqual(counters);
			}
			expect(tally.runCounts()).toEqual(counters);
			// And the snapshot's sums say the same as the columns (what stageMismatch used to check).
			const t = stageTotals(
				snapshot({ at: 0, tally, tracked: [], finished: [], drawnPrints: [], upload: null, thumbs: null, cleanup: null, flags: null })
			);
			expect([t.pages, t.unchanged, t.skipped, t.failed, t.drawn]).toEqual([
				counters.total,
				counters.unchanged,
				counters.skipped,
				counters.failed,
				counters.rendered
			]);
		}
	});

	test('the snapshot round-trips through the row’s JSON; rows from before stages have none', () => {
		const s = snap();
		expect(parseStages(JSON.parse(JSON.stringify(s)))).toEqual(s);
		expect(parseStages(JSON.stringify(s))).toEqual(s);
		expect(parseStages(null)).toBeNull();
		expect(parseStages({ v: 2 })).toBeNull();
		expect(parseStages('{')).toBeNull();
	});

	test('the tally hands out copies', () => {
		const t = stageTally();
		t.page(FP, 'queued');
		const a = t.sites.get('factorioprints')!;
		t.page(FP, 'drawn');
		expect(a.drawn).toBe(0);
		expect(t.sites.get('factorioprints')!.drawn).toBe(1);
	});
});
