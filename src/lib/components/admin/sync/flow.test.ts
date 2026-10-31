import { describe, expect, test } from 'bun:test';
import type { RenderStages } from '#lib/render-stages.js';
import type { RenderRun } from '#lib/server/admin/render.js';
import { logProgress } from '#lib/sync-progress.js';
import { DEFAULT_SETTINGS, GROUP, ROW, type SourcePlan, type SyncPlan, type SyncRun, type SyncStep } from '#lib/sync.js';
import { buildFlow, CELL_LINES, COLUMNS, fitCell, heroBar, nowSentence, renderNow, type Cell, type Flow } from './flow';
import finished from './flow.fixture.json';

// The update of 2026-10-30 (12:00Z): codex 431 and fprints 407 read and admitted, 3 codex records failed, the
// render step skipped because of them, other sites' screenshots 686 copied and 30 failed.
const RUN = finished as unknown as SyncRun;

const at = (id: string): SourcePlan['from'] => ({ id, date: 0 });
const plan = (sources: Partial<SourcePlan>[]): SyncPlan => ({
	checkedAt: 0,
	sources: sources.map((s) => ({
		site: 'factorioprints',
		from: at('afb755bc'),
		to: at('afb755bc'),
		prints: 0,
		added: 0,
		edited: 0,
		favourites: 0,
		deleted: [],
		modern: 0,
		blocked: null,
		...s
	}))
});
const BEFORE = plan([
	{ prints: 18_226 },
	{ site: 'uploads', ingestsItself: true, position: 'none waiting', from: at('none'), to: at('none') },
	{ site: 'codex', polled: true, prints: 456, added: 431, from: at('25@1'), to: at('456@1:x'), left: 431 },
	{ site: 'fprints', polled: true, prints: 432, added: 407, from: at('25@1'), to: at('432@1:y'), left: 407 }
]);
const flowOf = (o: Partial<Parameters<typeof buildFlow>[0]>) =>
	buildFlow({
		plan: BEFORE,
		run: null,
		phase: 'waiting',
		latestRender: null,
		progress: null,
		now: 0,
		clock: () => '01:14',
		...o
	});
const row = (f: Flow, site: string) => f.rows.find((r) => r.site === site)!;
const cellOf = (f: Flow, site: string, col: (typeof COLUMNS)[number]) => row(f, site).cells[col];
/** A cell as "kind: fact · fact", for short assertions. */
const said = (c: Cell) =>
	[
		c.kind,
		...c.facts.map((x) => (x.n !== undefined ? `${typeof x.n === 'number' ? x.n.toLocaleString('en-US') : x.n} ${x.text}`.trim() : x.text))
	].join(' · ');
/** Cells running now, outside the Render group. */
const running = (f: Flow) =>
	f.rows.flatMap((r) =>
		(['changes', 'added', 'authors', 'shots'] as const).filter((c) => r.cells[c].kind === 'run').map((c) => `${r.site} ${c}`)
	);

describe('the board, before an update', () => {
	const f = flowOf({});

	test('one row per source in order; Changes from the plan, everything to the right not run yet', () => {
		expect(f.mode).toBe('before');
		expect(f.rows.map((r) => r.site)).toEqual(['factorioprints', 'codex', 'fprints', 'uploads']);
		expect(said(cellOf(f, 'codex', 'changes'))).toBe('found · 431 new');
		expect(said(cellOf(f, 'factorioprints', 'changes'))).toBe('done');
		expect(cellOf(f, 'factorioprints', 'changes').tip).toContain('nothing new since the last update');
		for (const c of COLUMNS.slice(1)) expect(cellOf(f, 'factorioprints', c).kind).toBe('wait');
		// Authors don't apply to the other sources, before or after.
		expect(cellOf(f, 'codex', 'authors')).toMatchObject({ kind: 'na' });
		expect(row(f, 'codex').reach).toBe(0);
		expect(row(f, 'codex').toggle).toBe('codex');
		expect(f.caption.lead).toBe('Before an update:');
		expect(nowSentence(f, { plan: BEFORE, phase: 'waiting' })).toBe('Ready: 431 to read from codex, 407 to read from fprints.');
	});

	test('the Shared row: the settings the next update would use', () => {
		const g = flowOf({ settings: { workers: 4, perUpdate: 100, top: 1000, render: true } as never });
		expect(g.shared.summary).toEqual({ title: 'This run’s settings', lines: ['4 threads · ≤ 100 prints · top 1,000'] });
		expect(g.threads).toBe(4);
		expect(g.shared.sizing).toMatchObject({ kind: 'wait', label: 'Sizing and upload' });
		expect(g.shared.flags).toMatchObject({ kind: 'wait', label: 'Search flags' });
	});

	test('a held-back source says so in its Changes cell, with Accept', () => {
		const held = plan([{ added: 1200, from: at('afb755bc'), to: at('3c41f0e9'), blocked: '1,284 of 18,226 prints moved' }]);
		const g = flowOf({ plan: held, phase: 'blocked' });
		expect(said(cellOf(g, 'factorioprints', 'changes'))).toBe('warn · held back');
		expect(row(g, 'factorioprints').held).toEqual({
			reason: '1,284 of 18,226 prints moved',
			site: 'factorioprints',
			id: '3c41f0e9',
			polled: false
		});
		expect(nowSentence(g, { plan: held, phase: 'blocked' })).toBe('factorioprints is held back: too much changed at once.');
	});
});

describe('the board after the update of 2026-10-30', () => {
	const f = flowOf({ run: RUN, phase: 'current' });

	test('Changes: what each fetch read; the mirror had nothing new', () => {
		expect(f.mode).toBe('last');
		expect(said(cellOf(f, 'codex', 'changes'))).toBe('done · 431 read');
		expect(said(cellOf(f, 'fprints', 'changes'))).toBe('done · 407 read');
		expect(said(cellOf(f, 'factorioprints', 'changes'))).toBe('done');
		expect(cellOf(f, 'factorioprints', 'changes').tip).toContain('already at its latest (afb755b)');
	});

	test('Added: each site’s own outcome, "matched" for joined; the backfill skipped; authors not run', () => {
		expect(said(cellOf(f, 'codex', 'added'))).toBe('warn · 355 new · 73 matched · 3 failed');
		expect(said(cellOf(f, 'fprints', 'added'))).toBe('warn · 378 new · 27 matched · 2 unreadable');
		expect(said(cellOf(f, 'factorioprints', 'added'))).toBe('done');
		expect(cellOf(f, 'factorioprints', 'added').tip.startsWith('Backfill skipped: nothing changed')).toBe(true);
		expect(cellOf(f, 'factorioprints', 'authors')).toMatchObject({
			kind: 'wait',
			tip: 'Not run: needs "update the site\'s prints", which failed.'
		});
		expect(f.newPrints).toBe(733);
	});

	test('Screenshots: Imgur under factorioprints, each site its own, uploads under uploads', () => {
		expect(said(cellOf(f, 'factorioprints', 'shots'))).toBe('done');
		expect(cellOf(f, 'factorioprints', 'shots').tip).toBe('Imgur: already copied 18,111 · dead on Imgur 2 · to fetch 0.');
		expect(said(cellOf(f, 'codex', 'shots'))).toBe('warn · 356 copied · 30 failed');
		expect(said(f.shared.sizing)).toBe('done · 4,653 files · 1348.0 MB');
	});

	test('Render skipped: every stage not run, with the reason', () => {
		for (const c of ['plan', 'draw', 'upload', 'thumbs'] as const)
			expect(cellOf(f, 'codex', c)).toMatchObject({ kind: 'wait', tip: 'Not run: needs "update the site\'s prints", which failed.' });
		expect(row(f, 'codex').reach).toBe(3);
		expect(f.caption).toEqual({ lead: 'Last update', rest: '· finished 01:14' });
	});
});

describe('screenshots per source', () => {
	// The update of 2026-10-30 recorded each site's own group (SITE_SHOTS_GROUP).
	const withSites = (): SyncRun => structuredClone(RUN);

	test('each polled site’s own copies; failures make it a warning', () => {
		const f = flowOf({ run: withSites(), phase: 'current' });
		expect(said(cellOf(f, 'codex', 'shots'))).toBe('warn · 356 copied · 30 failed');
		expect(said(cellOf(f, 'fprints', 'shots'))).toBe('done · 330 copied');
		expect(cellOf(f, 'fprints', 'shots').tip).toBe('fprints’s own images for its prints: images shown 349 · already copied 19.');
	});

	test('while the step runs: the part its command names runs, one cell at a time', () => {
		const r = withSites();
		r.state = 'running';
		r.steps = r.steps.map((s) =>
			s.id === 'screenshots'
				? { ...s, status: 'running', details: undefined }
				: s.id === 'render' || s.id === 'figures'
					? { id: s.id, status: 'pending' }
					: s
		);
		const imgur = flowOf({
			run: r,
			phase: 'running',
			progress: logProgress('== Copy screenshots\n$ bun scripts/screenshots.ts --from-clone x --json\n')
		});
		expect(running(imgur)).toEqual(['factorioprints shots']);
		const sites = flowOf({
			run: r,
			phase: 'running',
			progress: logProgress(
				'== Copy screenshots\n$ bun scripts/screenshots.ts --from-sites prod --json\n' +
					'screenshots: codex.2cc33feefb7dd975 (codex-34): fetched\nscreenshots: fprints.0f688ce08ceec6a7 (fprints-1): fetched\n'
			)
		});
		expect(running(sites)).toEqual(['fprints shots']);
		expect(said(cellOf(sites, 'codex', 'shots'))).toBe('part · 1 copied');
		expect(said(cellOf(sites, 'factorioprints', 'shots'))).toBe('done');
		expect(sites.shared.sizing.kind).toBe('wait');
		const sizing = flowOf({
			run: r,
			phase: 'running',
			progress: logProgress('== Copy screenshots\n$ bun scripts/screenshots.ts --upload prod --json\n')
		});
		expect(sizing.shared.sizing.kind).toBe('run');
		expect(nowSentence(sizing, { plan: BEFORE, phase: 'running' })).toBe('Sizing the new screenshots and putting them in the bucket.');
	});
});

describe('the board while an update runs', () => {
	/** The run as it stood in its fetch step: codex read, fprints reading. */
	const mid = (): SyncRun => {
		const r = structuredClone(RUN);
		r.state = 'running';
		r.finished_at = null;
		r.sources = r.sources.map((s) => (s.site === 'fprints' ? { ...s, counts: undefined, to: s.from } : s));
		r.steps = r.steps.map((s) =>
			s.id === 'removals'
				? s
				: s.id === 'fetch'
					? { ...s, status: 'running', details: undefined, finishedAt: undefined }
					: { id: s.id, status: 'pending' }
		);
		return r;
	};

	test('fetch: the site reading now counts up from the log, against what its plan said; one running cell', () => {
		const progress = logProgress(`== Fetch new prints\n${'fprints/a: new\n'.repeat(180)}`);
		const f = flowOf({ run: mid(), phase: 'running', progress });
		expect(said(cellOf(f, 'codex', 'changes'))).toBe('done · 431 read');
		expect(cellOf(f, 'fprints', 'changes')).toMatchObject({ kind: 'run', bar: 44, facts: [{ n: '180 of 407', text: 'read' }] });
		expect(running(f)).toEqual(['fprints changes']);
		expect(f.current).toBe('fetch');
		expect(f.caption).toEqual({ lead: 'This update', rest: '· step 2 of 7' });
		const sentence = nowSentence(f, { plan: BEFORE, phase: 'running' });
		expect(sentence).toBe('Reading fprints: 180 of 407, about one a second.');
		// The top box's bar: the reading source's fraction.
		expect(heroBar(f, null)).toBe(44);
	});

	test('the gate: one source at a time; the one being added runs, the next waits its turn', () => {
		const r = structuredClone(RUN);
		r.state = 'running';
		r.steps = r.steps.map((s) =>
			s.id === 'ingest'
				? { ...s, status: 'running', details: undefined, summary: undefined }
				: ['authors', 'screenshots', 'render', 'figures'].includes(s.id)
					? { id: s.id, status: 'pending' }
					: s
		);
		const progress = logProgress(
			"== Update the site's prints\nprod ← codex inbox x: 431 records to admit, 0 gone from the site\n" +
				'codex/1: new\ncodex/2: joined (-Abc)\ncodex/3: failed (remote /d1)\n'
		);
		const f = flowOf({ run: r, phase: 'running', progress });
		expect(cellOf(f, 'codex', 'added')).toMatchObject({ kind: 'run', facts: [{ n: '3 of 431', text: 'added' }] });
		expect(cellOf(f, 'fprints', 'added').kind).toBe('wait');
		expect(running(f)).toEqual(['codex added']);
		expect(nowSentence(f, { plan: BEFORE, phase: 'running' })).toBe('Adding codex prints through the gate: 3 of 431.');
		// Once fprints' admission starts, codex's is over (its figures come at the step's end).
		const later = logProgress(
			`== Update the site's prints\nprod ← codex inbox x: 2 records to admit\ncodex/1: new\ncodex/2: failed (x)\nprod ← fprints inbox y: 9 records to admit\nfprints/a: new\n`
		);
		const g = flowOf({ run: r, phase: 'running', progress: later });
		expect(said(cellOf(g, 'codex', 'added'))).toBe('warn · 1 new · 1 failed');
		expect(running(g)).toEqual(['fprints added']);
	});
});

describe('render per source', () => {
	/** A render run's stages: factorioprints done, codex part-way (10 failed pages), fprints drawn, its uploads going. */
	const stages = (o: Partial<RenderStages> = {}): RenderStages => ({
		v: 1,
		at: 0,
		sites: {
			factorioprints: {
				plan: { prints: 4, pages: 320, queued: 212, unchanged: 96, skipped: 12, failed: 0 },
				draw: { drawn: 212, failed: 0, left: 0, printsDone: 4, printsDrawn: 4 },
				upload: { pages: 212, files: 9000, bytes: 1, waiting: 0, failing: 0, printsUp: 4 },
				thumbs: { done: 4, of: 4 }
			},
			codex: {
				plan: { prints: 58, pages: 2959, queued: 2117, unchanged: 702, skipped: 140, failed: 0 },
				draw: { drawn: 2000, failed: 10, left: 107, printsDone: 41, printsDrawn: 50 },
				upload: { pages: 1404, files: 60000, bytes: 1, waiting: 596, failing: 0, printsUp: 30 },
				thumbs: { done: 41, of: 41 }
			},
			fprints: {
				plan: { prints: 41, pages: 1756, queued: 1310, unchanged: 386, skipped: 60, failed: 0 },
				draw: { drawn: 1310, failed: 0, left: 0, printsDone: 41, printsDrawn: 41 },
				upload: { pages: 876, files: 30000, bytes: 1, waiting: 434, failing: 0, printsUp: 20 },
				thumbs: { done: 35, of: 41 }
			}
		},
		cleanup: { state: 'waiting', deleted: 0, kept: 0, failed: 0, pending: 0, nextDue: null, thumbsDeleted: 0 },
		flags: { state: 'waiting', stage: 'prod' },
		...o
	});
	const renderRow = (o: Partial<RenderRun> = {}, s: RenderStages = stages()) =>
		({
			id: 'r1',
			state: 'running',
			started_at: 1_000_100,
			prints_total: 103,
			prints_done: 86,
			rendered: 3522,
			uploaded: 2492,
			failed: 10,
			uploads_pending: 1030,
			upload_target: 'prod',
			eta_seconds: 600,
			options: { phase: null, stages: s },
			...o
		}) as RenderRun;
	const inRender = (): SyncRun => {
		const r = structuredClone(RUN);
		r.state = 'running';
		r.steps = r.steps.map((s): SyncStep =>
			s.id === 'render'
				? { id: 'render', status: 'running', startedAt: 1_000_000 }
				: s.id === 'figures'
					? { id: s.id, status: 'pending' }
					: s.id === 'authors'
						? { ...s, status: 'done', summary: 'nothing to do' }
						: s
		);
		return r;
	};

	test('while drawing: each source part-way where its prints still move; uploads said honestly', () => {
		const f = flowOf({ run: inRender(), phase: 'running', liveRender: renderRow() });
		expect(f.current).toBe('render');
		expect(said(cellOf(f, 'factorioprints', 'plan'))).toBe('done · 4 prints · 212 pages to draw · 12 skipped');
		expect(said(cellOf(f, 'factorioprints', 'upload'))).toBe('done · 212 pages uploaded · 4 of 4 prints');
		// Three lines: pages, prints, failures; the pages still to draw go in the tooltip.
		expect(said(cellOf(f, 'codex', 'draw'))).toBe('part · 2,000 pages drawn · 41 of 58 prints · 10 failed');
		expect(cellOf(f, 'codex', 'draw').tip.endsWith('Also: 107 to draw.')).toBe(true);
		expect(said(cellOf(f, 'codex', 'upload'))).toBe('part · 1,404 pages uploaded · 30 of 58 prints · 596 waiting');
		expect(cellOf(f, 'codex', 'upload').tip).toContain('Up to 107 more pages to come.');
		expect(said(cellOf(f, 'codex', 'thumbs'))).toBe('part · 41 of 41 prints');
		expect(said(cellOf(f, 'fprints', 'draw'))).toBe('done · 1,310 pages drawn · 41 of 41 prints');
		expect(said(cellOf(f, 'fprints', 'upload'))).toBe('part · 876 pages uploaded · 20 of 41 prints · 434 waiting');
		expect(said(cellOf(f, 'fprints', 'thumbs'))).toBe('part · 35 of 41 prints');
		// A source with nothing in this batch: a bare ✓, saying why.
		expect(cellOf(f, 'uploads', 'plan')).toMatchObject({ kind: 'done', facts: [] });
		expect(cellOf(f, 'uploads', 'plan').tip.startsWith('None in this batch')).toBe(true);
		expect(row(f, 'codex').reach).toBe(7);
		// Nothing outside the Render group runs.
		expect(running(f)).toEqual([]);
		expect(/^One run · .* so far$/.test(f.shared.summary.title)).toBe(true);
		expect(f.shared.summary.lines.at(-1)).toBe('103 prints · 3,522 pages drawn · 10 failed');
		expect(f.shared.cleanup.kind).toBe('wait');
		expect(f.renderNow).toMatchObject({ phase: 'drawing', value: 86, of: 103 });
		expect(nowSentence(f, { plan: BEFORE, phase: 'running' })).toBe('Drawing prints: 86 of 103.');
		expect(heroBar(f, null)).toBe(83);
	});

	test('retrying failed pages: said in the Plan cell’s tooltip, before an update and while it runs', () => {
		const settings = { ...DEFAULT_SETTINGS, retryFailed: true };
		const r = inRender();
		const f = flowOf({ run: { ...r, options: { ...r.options, settings } }, phase: 'running', liveRender: renderRow() });
		expect(cellOf(f, 'codex', 'plan').tip).toContain('Retrying failed pages');
		expect(cellOf(flowOf({ settings }), 'codex', 'plan').tip).toContain('retry failed pages (this update only)');
		expect(cellOf(flowOf({ run: inRender(), phase: 'running', liveRender: renderRow() }), 'codex', 'plan').tip).not.toContain('Retrying');
	});

	test('Thumbnails: pages made of those to make, prints done, prints waiting on their render upload', () => {
		const s = stages();
		s.sites.codex!.thumbs = { done: 30, of: 41, pagesMade: 310, pagesOf: 420, waitingUpload: 6 };
		const f = flowOf({ run: inRender(), phase: 'running', liveRender: renderRow({}, s) });
		expect(said(cellOf(f, 'codex', 'thumbs'))).toBe('part · 310 of 420 pages · 30 of 41 prints · 6 waiting on upload');
		// None waiting: no third line; a snapshot from before the page counts: prints only.
		s.sites.codex!.thumbs = { done: 41, of: 41, pagesMade: 420, pagesOf: 420, waitingUpload: 0 };
		expect(said(cellOf(flowOf({ run: inRender(), phase: 'running', liveRender: renderRow({}, s) }), 'codex', 'thumbs'))).toBe(
			'part · 420 of 420 pages · 41 of 41 prints'
		);
		expect(said(cellOf(f, 'fprints', 'thumbs'))).toBe('part · 35 of 41 prints');
	});

	test('Thumbnails: while a print’s files go up, "N of M files uploading" leads, the pages line last (to the tooltip when the cell is full)', () => {
		const s = stages();
		s.sites.codex!.thumbs = { done: 49, of: 50, pagesMade: 657, pagesOf: 657, waitingUpload: 0, filesUp: 900, filesOf: 1937 };
		const live = flowOf({ run: inRender(), phase: 'running', liveRender: renderRow({ options: { phase: 'thumbnails', stages: s } }) });
		const c = cellOf(live, 'codex', 'thumbs');
		expect(said(c)).toBe('part · 900 of 1,937 files uploading · 49 of 50 prints · 657 of 657 pages');
		expect(live.renderNow?.sentence).toBe('Making and uploading thumbnails: 88 of 95 prints. Uploading 900 of 1,937 files.');
		// With prints waiting too, still three lines: the pages line goes to the tooltip. None uploading: as before.
		s.sites.codex!.thumbs = { ...s.sites.codex!.thumbs, waitingUpload: 2 };
		const full = cellOf(flowOf({ run: inRender(), phase: 'running', liveRender: renderRow({}, s) }), 'codex', 'thumbs');
		expect(said(full)).toBe('part · 900 of 1,937 files uploading · 49 of 50 prints · 2 waiting on upload');
		expect(full.tip).toContain('Also: 657 of 657 pages.');
		s.sites.codex!.thumbs = { ...s.sites.codex!.thumbs, waitingUpload: 0, filesUp: 0, filesOf: 0 };
		expect(said(cellOf(flowOf({ run: inRender(), phase: 'running', liveRender: renderRow({}, s) }), 'codex', 'thumbs'))).toBe(
			'part · 657 of 657 pages · 49 of 50 prints'
		);
	});

	test('a render run from before this step isn’t this update’s', () => {
		const f = flowOf({ run: inRender(), phase: 'running', liveRender: renderRow({ started_at: 900_000 }) });
		expect(cellOf(f, 'codex', 'plan').kind).toBe('wait');
		expect(f.renderNow?.phase).toBe('picking');
	});

	test('after the last page: the run row’s phase names what it does', () => {
		// Thumbnails: every source's from the stages, 80 of 103 prints.
		const s = stages();
		s.sites.fprints!.thumbs = { done: 35, of: 58 };
		const thumbs = flowOf({ run: inRender(), phase: 'running', liveRender: renderRow({ options: { phase: 'thumbnails', stages: s } }) });
		expect(thumbs.renderNow).toEqual({
			phase: 'thumbnails',
			sentence: 'Making and uploading thumbnails: 80 of 103 prints.',
			value: 80,
			of: 103
		});
		// The top box's bar: prints finished (thumbnails done) of those picked.
		expect(heroBar(thumbs, null)).toBe(78);
		expect(
			heroBar(flowOf({ run: inRender(), phase: 'running', liveRender: renderRow({ options: { phase: 'deletions' } }) }), null)
		).toBeNull();
		expect(renderNow(renderRow({ options: { phase: 'deletions' } })).sentence).toBe('Removing replaced files from the bucket.');
		expect(
			renderNow(renderRow({ options: { phase: 'flags', stages: stages({ flags: { state: 'running', stage: 'prod' } }) } })).sentence
		).toBe('Setting the search flags on prod.');
		const failed = renderNow(
			renderRow({ options: { phase: 'flags', stages: stages({ flags: { state: 'failed', stage: 'prod', error: 'x' } }) } })
		);
		expect(failed.sentence).toBe('Setting the search flags on prod failed: run render:flags by hand.');
		expect(renderNow(renderRow({ state: 'starting' })).phase).toBe('queueing');
		expect(renderNow(null).sentence).toBe('Picking the prints to render.');
		// Clean up and search flags run inside the group, so they may spin beside it.
		const flagsNow = flowOf({
			run: inRender(),
			phase: 'running',
			liveRender: renderRow(
				{},
				stages({
					cleanup: { state: 'done', deleted: 186, kept: 0, failed: 0, pending: 41, nextDue: null, thumbsDeleted: 0 },
					flags: { state: 'running', stage: 'prod' }
				})
			)
		});
		expect(said(flagsNow.shared.cleanup)).toBe('done · 186 deleted · 41 in grace');
		expect(flagsNow.shared.flags).toMatchObject({ kind: 'run', label: 'Search flags' });
	});

	test('finished: the step’s own stages; the detail bar’s one sentence', () => {
		const r = inRender();
		r.state = 'finished';
		const done = stages({
			sites: {
				...stages().sites,
				codex: {
					...stages().sites.codex!,
					draw: { drawn: 2107, failed: 10, left: 0, printsDone: 58, printsDrawn: 58 },
					upload: { pages: 2107, files: 1, bytes: 1, waiting: 0, failing: 0, printsUp: 58 },
					thumbs: { done: 58, of: 58 }
				}
			},
			cleanup: { state: 'done', deleted: 180, kept: 2, failed: 0, pending: 41, nextDue: null, thumbsDeleted: 6 },
			flags: { state: 'done', stage: 'prod', rowsWritten: 102, bumped: true }
		});
		const step: SyncStep = {
			id: 'render',
			status: 'warning',
			startedAt: 1_000_000,
			finishedAt: 1_000_000 + 3_590_000,
			summary: 's',
			render: done,
			runId: 'r1'
		};
		r.steps = r.steps.map((s) => (s.id === 'render' ? step : s.id === 'figures' ? { ...s, status: 'done' } : s));
		const f = flowOf({ run: r, phase: 'current', latestRender: null });
		expect(said(cellOf(f, 'codex', 'draw'))).toBe('warn · 2,107 pages drawn · 58 of 58 prints · 10 failed');
		expect(said(cellOf(f, 'codex', 'upload'))).toBe('done · 2,107 pages uploaded · 58 of 58 prints');
		expect(said(cellOf(f, 'codex', 'thumbs'))).toBe('done · 58 of 58 prints');
		// fprints ended with pages still to upload: a warning, for the next update.
		expect(said(cellOf(f, 'fprints', 'upload'))).toBe('warn · 876 pages uploaded · 20 of 41 prints · 434 waiting');
		expect(said(f.shared.cleanup)).toBe('done · 186 deleted · 41 in grace');
		expect(said(f.shared.flags)).toBe('done · 102 rows written · cache bumped');
		expect(f.shared.summary.title).toBe('One run · 59 min');
		expect(f.current).toBeNull();
		// Finished: no bar in the top box.
		expect(heroBar(f, null)).toBeNull();
	});

	test('an ended step shows only its own stages, or the run it names: never a run started by hand later', () => {
		const r = inRender();
		r.state = 'finished';
		const failed: SyncStep = { id: 'render', status: 'failed', startedAt: 1_000_000, finishedAt: 1_005_000, summary: 'exit 1: no clone' };
		r.steps = r.steps.map((s) => (s.id === 'render' ? failed : s));
		const byHand = renderRow({ id: 'by-hand', started_at: 2_000_000, state: 'finished' });
		const f = flowOf({ run: r, phase: 'current', latestRender: byHand, liveRender: null });
		expect(cellOf(f, 'codex', 'plan')).toMatchObject({ kind: 'bad', facts: [] });
		expect(f.shared.cleanup.kind).toBe('bad');
		// A step from before `render` was recorded, naming its run: that run's stages.
		r.steps = r.steps.map((s) => (s.id === 'render' ? { ...failed, status: 'done', runId: 'r1' } : s));
		const old = flowOf({ run: r, phase: 'current', latestRender: renderRow({ state: 'finished' }), liveRender: null });
		expect(said(cellOf(old, 'codex', 'plan'))).toBe('done · 58 prints · 2,117 pages to draw · 140 skipped');
		// While the step runs, a run that isn't live (stopped responding, or a finished one) isn't read.
		const g = flowOf({ run: inRender(), phase: 'running', latestRender: renderRow(), liveRender: null });
		expect(cellOf(g, 'codex', 'plan').kind).toBe('wait');
	});

	test('a site only the render drew gets a row of its own', () => {
		const s = stages();
		s.sites.factoriobin = { ...s.sites.fprints!, plan: { ...s.sites.fprints!.plan, prints: 1 } };
		const f = flowOf({ run: inRender(), phase: 'running', liveRender: renderRow({}, s) });
		expect(f.rows.map((r) => r.site)).toEqual(['factorioprints', 'codex', 'fprints', 'uploads', 'factoriobin']);
		expect(cellOf(f, 'factoriobin', 'changes').kind).toBe('na');
		expect(said(cellOf(f, 'factoriobin', 'plan'))).toBe('done · 1 prints · 1,310 pages to draw · 60 skipped');
	});
});

describe('one size for every cell', () => {
	const facts = (n: number) => Array.from({ length: n }, (_, i) => ({ n: i + 1, text: `f${i}` }));

	test('fitCell keeps three lines, failures and warnings first, the rest in the tooltip', () => {
		const c: Cell = {
			kind: 'warn',
			facts: [...facts(3), { n: 9, text: 'failed', tone: 'bad' }, { n: 1_234, text: 'left over', tone: 'warn' }],
			tip: 'Read.'
		};
		const fit = fitCell(c);
		expect(said(fit)).toBe('warn · 1 f0 · 9 failed · 1,234 left over');
		expect(fit.tip).toBe('Read. Also: 2 f1, 3 f2.');
		expect(fitCell({ ...c, facts: facts(3) })).toEqual({ ...c, facts: facts(3) });
		// A label takes a line; a held-back cell keeps one for its Accept button.
		expect(fitCell({ ...c, facts: facts(3), label: 'Clean up' }).facts.length).toBe(2);
		expect(fitCell({ ...c, facts: facts(2), tip: '' }, 1).tip).toBe('Also: 2 f1.');
	});

	test('no cell on any board has more than three lines', () => {
		const boards = [flowOf({}), flowOf({ run: RUN, phase: 'current' })];
		for (const f of boards) {
			const cells = [...f.rows.flatMap((r) => COLUMNS.map((c) => r.cells[c])), f.shared.sizing, f.shared.cleanup, f.shared.flags];
			for (const c of cells) expect(c.facts.length + (c.label ? 1 : 0) <= CELL_LINES).toBe(true);
			expect(f.shared.summary.lines.length + 1 <= CELL_LINES).toBe(true);
		}
	});
});

describe('the Authors cell', () => {
	const withAuthors = (named: number): SyncRun => {
		const r = structuredClone(RUN);
		const i = r.steps.findIndex((s) => s.id === 'authors');
		r.steps[i] = {
			id: 'authors',
			status: 'done',
			summary: `${named} authors named, 9 prints given a name`,
			details: [
				{
					title: GROUP.authors,
					rows: [
						{ label: ROW.authorsNamed, value: named },
						{ label: 'asked Firebase', value: 4 }
					]
				}
			]
		};
		return r;
	};
	test('"N named" from the step’s figures; a bare ✓ when none', () => {
		const f = flowOf({ run: withAuthors(6), phase: 'current' });
		expect(said(cellOf(f, 'factorioprints', 'authors'))).toBe('done · 6 named');
		expect(cellOf(f, 'factorioprints', 'authors').tip).toContain('authors named 6 · asked Firebase 4');
		expect(said(cellOf(flowOf({ run: withAuthors(0), phase: 'current' }), 'factorioprints', 'authors'))).toBe('done');
		expect(cellOf(f, 'codex', 'authors').kind).toBe('na');
	});
});

describe('an update from before the stages and the per-site groups', () => {
	const old = (): SyncRun => {
		const r = structuredClone(RUN);
		const render = r.steps.findIndex((s) => s.id === 'render');
		r.steps[render] = { id: 'render', status: 'done', summary: '12 prints: 80 pages drawn' };
		const shots = r.steps.find((s) => s.id === 'screenshots')!;
		shots.details = [
			...shots.details!.filter((g) => !g.title?.startsWith('From other sites')),
			{ title: 'From other sites', rows: [{ label: ROW.copiedNow, value: 686 }] }
		];
		return r;
	};
	test('a render step that ran says so, not "not run"; screenshots counted together read as copied', () => {
		const f = flowOf({ run: old(), phase: 'current' });
		expect(said(cellOf(f, 'codex', 'plan'))).toBe('done · not counted per source');
		expect(cellOf(f, 'codex', 'plan').tip).toBe('12 prints: 80 pages drawn: see the step’s figures.');
		expect(f.shared.cleanup.kind).toBe('done');
		expect(cellOf(f, 'codex', 'shots')).toMatchObject({ kind: 'done' });
		expect(cellOf(f, 'codex', 'shots').tip).toContain('counted them together');
		const warned = old();
		warned.steps.find((s) => s.id === 'render')!.status = 'warning';
		expect(cellOf(flowOf({ run: warned, phase: 'current' }), 'codex', 'draw').kind).toBe('warn');
	});
});
