import { describe, expect, test } from 'bun:test';
import type { RenderStages } from '#lib/render-stages.js';
import type { RenderRun } from '#lib/server/admin/render.js';
import { logProgress } from '#lib/sync-progress.js';
import { SITE_SHOTS_GROUP, type SourcePlan, type SyncPlan, type SyncRun, type SyncStep } from '#lib/sync.js';
import { buildFlow, COLUMNS, nowSentence, renderNow, stepLine, type Cell, type Flow } from './flow';
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

	test('Screenshots: Imgur under factorioprints, uploads under uploads; an update before per-site groups says so', () => {
		expect(said(cellOf(f, 'factorioprints', 'shots'))).toBe('done');
		expect(cellOf(f, 'factorioprints', 'shots').tip).toBe('Imgur: already copied 18,111 · dead on Imgur 2 · to fetch 0.');
		expect(cellOf(f, 'codex', 'shots').tip).toContain('counted other sites’ images together');
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
	const withSites = (): SyncRun => {
		const r = structuredClone(RUN);
		const shots = r.steps.find((s) => s.id === 'screenshots')!;
		shots.details!.push(
			{
				title: `${SITE_SHOTS_GROUP}codex`,
				rows: [
					{ label: 'images shown', value: 400 },
					{ label: 'copied now', value: 356 },
					{ label: 'failed, tried again next update', value: 30, tone: 'bad' }
				]
			},
			{
				title: `${SITE_SHOTS_GROUP}fprints`,
				rows: [
					{ label: 'images shown', value: 349 },
					{ label: 'copied now', value: 330 }
				]
			}
		);
		return r;
	};

	test('each polled site’s own copies; failures make it a warning', () => {
		const f = flowOf({ run: withSites(), phase: 'current' });
		expect(said(cellOf(f, 'codex', 'shots'))).toBe('warn · 356 copied · 30 failed');
		expect(said(cellOf(f, 'fprints', 'shots'))).toBe('done · 330 copied');
		expect(cellOf(f, 'fprints', 'shots').tip).toBe('fprints’s own images for its prints: images shown 349.');
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
		expect(stepLine(f, mid().steps[1], sentence)).toEqual({
			lead: 'Reading fprints',
			rest: '180 of 407, about one a second.',
			bar: 44,
			tone: null
		});
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
				upload: { pages: 212, files: 9000, bytes: 1, waiting: 0, failing: 0 },
				thumbs: { done: 4, of: 4 }
			},
			codex: {
				plan: { prints: 58, pages: 2959, queued: 2117, unchanged: 702, skipped: 140, failed: 0 },
				draw: { drawn: 2000, failed: 10, left: 107, printsDone: 41, printsDrawn: 50 },
				upload: { pages: 1404, files: 60000, bytes: 1, waiting: 596, failing: 0 },
				thumbs: { done: 41, of: 41 }
			},
			fprints: {
				plan: { prints: 41, pages: 1756, queued: 1310, unchanged: 386, skipped: 60, failed: 0 },
				draw: { drawn: 1310, failed: 0, left: 0, printsDone: 41, printsDrawn: 41 },
				upload: { pages: 876, files: 30000, bytes: 1, waiting: 434, failing: 0 },
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
			options: { phase: null, thumbs: { done: 80, of: 86 }, stages: s },
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
		const f = flowOf({ run: inRender(), phase: 'running', latestRender: renderRow() });
		expect(f.rendering).toBe(true);
		expect(said(cellOf(f, 'factorioprints', 'plan'))).toBe('done · 4 prints · 212 to draw · 12 skipped');
		expect(said(cellOf(f, 'factorioprints', 'upload'))).toBe('done · 212 uploaded');
		expect(said(cellOf(f, 'codex', 'draw'))).toBe('part · 2,000 drawn · 10 failed · 107 to draw');
		expect(said(cellOf(f, 'codex', 'upload'))).toBe('part · 1,404 uploaded · 596 waiting · up to 107 more');
		expect(said(cellOf(f, 'codex', 'thumbs'))).toBe('part · 41 of 41 prints');
		expect(said(cellOf(f, 'fprints', 'draw'))).toBe('done · 1,310 drawn');
		expect(said(cellOf(f, 'fprints', 'upload'))).toBe('part · 876 uploaded · 434 waiting');
		expect(said(cellOf(f, 'fprints', 'thumbs'))).toBe('part · 35 of 41 prints');
		// A source with nothing in this batch: a bare ✓, saying why.
		expect(cellOf(f, 'uploads', 'plan')).toMatchObject({ kind: 'done', facts: [] });
		expect(cellOf(f, 'uploads', 'plan').tip.startsWith('None in this batch')).toBe(true);
		expect(row(f, 'codex').reach).toBe(7);
		// Nothing outside the Render group runs; its header spins instead.
		expect(running(f)).toEqual([]);
		expect(/^One run · .* so far$/.test(f.shared.summary.title)).toBe(true);
		expect(f.shared.summary.lines.at(-1)).toBe('103 prints · 3,522 pages drawn · 10 failed');
		expect(f.shared.cleanup.kind).toBe('wait');
		expect(f.renderNow).toMatchObject({ phase: 'drawing', value: 86, of: 103 });
		expect(nowSentence(f, { plan: BEFORE, phase: 'running' })).toBe('Drawing prints: 86 of 103.');
	});

	test('a render run from before this step isn’t this update’s', () => {
		const f = flowOf({ run: inRender(), phase: 'running', latestRender: renderRow({ started_at: 900_000 }) });
		expect(cellOf(f, 'codex', 'plan').kind).toBe('wait');
		expect(f.renderNow?.phase).toBe('picking');
	});

	test('after the last page: the run row’s phase names what it does', () => {
		const thumbs = flowOf({
			run: inRender(),
			phase: 'running',
			latestRender: renderRow({ options: { phase: 'thumbnails', thumbs: { done: 80, of: 103 } } })
		});
		expect(thumbs.renderNow).toMatchObject({ label: 'Making and uploading thumbnails', value: 80, of: 103 });
		const step = inRender().steps.find((s) => s.id === 'render')!;
		expect(stepLine(thumbs, step, '')).toEqual({
			lead: 'Making and uploading thumbnails',
			rest: '80 of 103 prints · 3,522 pages drawn · 2,492 uploaded · 10 failed',
			bar: 78,
			tone: null
		});
		expect(renderNow(renderRow({ options: { phase: 'deletions' } })).sentence).toBe('Removing replaced files from the bucket.');
		expect(
			renderNow(renderRow({ options: { phase: 'flags', stages: stages({ flags: { state: 'running', stage: 'prod' } }) } })).sentence
		).toBe('Setting the search flags on prod.');
		const failed = renderNow(
			renderRow({ options: { phase: 'flags', stages: stages({ flags: { state: 'failed', stage: 'prod', error: 'x' } }) } })
		);
		expect(failed).toMatchObject({ warn: true, sentence: 'Setting the search flags on prod failed: run render:flags by hand.' });
		expect(renderNow(renderRow({ state: 'starting' })).phase).toBe('queueing');
		expect(renderNow(null).sentence).toBe('Picking the prints to render.');
		// Clean up and search flags run inside the group, so they may spin beside it.
		const flagsNow = flowOf({
			run: inRender(),
			phase: 'running',
			latestRender: renderRow(
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
					upload: { pages: 2107, files: 1, bytes: 1, waiting: 0, failing: 0 },
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
		expect(said(cellOf(f, 'codex', 'draw'))).toBe('warn · 2,107 drawn · 10 failed');
		expect(said(cellOf(f, 'codex', 'upload'))).toBe('done · 2,107 uploaded');
		expect(said(cellOf(f, 'codex', 'thumbs'))).toBe('done · 58 of 58 prints');
		// fprints ended with pages still to upload: a warning, for the next update.
		expect(said(cellOf(f, 'fprints', 'upload'))).toBe('warn · 876 uploaded · 434 waiting');
		expect(said(f.shared.cleanup)).toBe('done · 186 deleted · 41 in grace');
		expect(said(f.shared.flags)).toBe('done · 102 rows written · cache bumped');
		expect(f.shared.summary.title).toBe('One run · 59 min');
		expect(f.rendering).toBe(false);
		expect(stepLine(f, step, '')).toMatchObject({
			lead: 'Finished with a warning',
			rest: '103 prints · 3,629 pages drawn · 3,195 uploaded · 10 failed · 434 left to upload · 97 prints’ thumbnails · 186 replaced files deleted · search flags set on prod',
			tone: 'warn'
		});
	});

	test('a site only the render drew gets a row of its own', () => {
		const s = stages();
		s.sites.factoriobin = { ...s.sites.fprints!, plan: { ...s.sites.fprints!.plan, prints: 1 } };
		const f = flowOf({ run: inRender(), phase: 'running', latestRender: renderRow({}, s) });
		expect(f.rows.map((r) => r.site)).toEqual(['factorioprints', 'codex', 'fprints', 'uploads', 'factoriobin']);
		expect(cellOf(f, 'factoriobin', 'changes').kind).toBe('na');
		expect(said(cellOf(f, 'factoriobin', 'plan'))).toBe('done · 1 prints · 1,310 to draw · 60 skipped');
	});
});
