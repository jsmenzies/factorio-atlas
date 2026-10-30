import { describe, expect, test } from 'bun:test';
import type { RenderRun } from '#lib/server/admin/render.js';
import { logProgress } from '#lib/sync-progress.js';
import type { SourcePlan, SyncPlan, SyncRun } from '#lib/sync.js';
import { buildFlow, nowSentence } from './flow';
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
		liveRender: null,
		progress: null,
		now: 0,
		timeZone: 'UTC',
		clock: () => '01:14',
		...o
	});
const lane = (f: ReturnType<typeof buildFlow>, site: string) => f.lanes.find((l) => l.site === site)!;

describe('the flow, before an update', () => {
	test('one lane per source in order; Waiting from the plan', () => {
		const f = flowOf({});
		expect(f.lanes.map((l) => l.site)).toEqual(['factorioprints', 'codex', 'fprints', 'uploads']);
		expect(lane(f, 'codex').waiting).toMatchObject({ state: 'done', value: 431, text: '431 new · 0 changed' });
		expect(lane(f, 'factorioprints').waiting).toMatchObject({ state: 'skip', text: 'up to date · afb755b' });
		expect(lane(f, 'uploads').waiting).toMatchObject({ state: 'skip', text: 'none waiting' });
		expect(nowSentence(f, { plan: BEFORE, run: null, phase: 'waiting', liveRender: null })).toBe(
			'Ready: 431 to read from codex, 407 to read from fprints.'
		);
	});

	test('a held-back source says so on its lane and in the sentence', () => {
		const held = plan([{ added: 1200, from: at('afb755bc'), to: at('3c41f0e9'), blocked: '1,284 of 18,226 prints moved' }]);
		const f = flowOf({ plan: held, phase: 'blocked' });
		expect(lane(f, 'factorioprints').waiting).toMatchObject({ state: 'held', text: 'held back' });
		expect(nowSentence(f, { plan: held, run: null, phase: 'blocked', liveRender: null })).toBe(
			'factorioprints is held back: too much changed at once.'
		);
	});
});

describe('the flow after the update of 2026-10-30', () => {
	const f = flowOf({ run: RUN, phase: 'current' });

	test('each site read what its fetch recorded; the mirror had nothing new', () => {
		expect(lane(f, 'codex').read).toMatchObject({ state: 'done', value: 431, figs: [{ label: 'new', value: 431 }] });
		expect(lane(f, 'fprints').read.value).toBe(407);
		expect(lane(f, 'factorioprints').read).toMatchObject({ state: 'skip', text: 'already at its latest (afb755b)' });
	});

	test('the gate: each polled site’s own outcome; the backfill skipped; authors skipped with its reason', () => {
		expect(lane(f, 'codex').gate).toMatchObject({
			state: 'warn',
			of: 431,
			outcome: { of: 431, new: 355, joined: 73, suggest: 66, unreadable: 0, failed: 3 }
		});
		expect(lane(f, 'fprints').gate.outcome).toMatchObject({ new: 378, joined: 27, suggest: 31, unreadable: 2, failed: 0 });
		expect(lane(f, 'factorioprints').gate.state).toBe('skip');
		expect(lane(f, 'factorioprints').gate.text?.startsWith('skipped: nothing changed')).toBe(true);
		expect(lane(f, 'factorioprints').authors).toMatchObject({ state: 'skip', text: 'needs "update the site\'s prints", which failed' });
		expect(f.newPrints).toBe(733);
	});

	test('screenshots: three inputs and one sizing, never split per site; render skipped, shared', () => {
		const sites = f.shots.inputs.find((i) => i.key === 'sites')!;
		expect(sites.sites).toEqual(['codex', 'fprints']);
		expect(sites.stage.figs?.some((x) => x.label === 'copied now' && x.value === 686)).toBe(true);
		expect(sites.stage.state).toBe('warn');
		expect(f.shots.sizing.figs?.some((x) => x.label === 'sizes made')).toBe(true);
		expect(f.render).toMatchObject({ state: 'skip', text: 'needs "update the site\'s prints", which failed' });
		expect(f.caption).toBe('Last update · finished 01:14');
	});
});

describe('the flow while an update runs', () => {
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

	test('fetch: the site reading now counts up from the log, against what its plan said', () => {
		const progress = logProgress(`== Fetch new prints\n${'fprints/a: new\n'.repeat(180)}`);
		const f = flowOf({ run: mid(), phase: 'running', progress });
		expect(lane(f, 'codex').read.state).toBe('done');
		expect(lane(f, 'fprints').read).toMatchObject({ state: 'active', value: 180, of: 407 });
		expect(f.current).toBe('fetch');
		expect(nowSentence(f, { plan: BEFORE, run: mid(), phase: 'running', liveRender: null })).toBe(
			'Reading fprints.xyz: 180 of 407, about one a second.'
		);
	});

	test('the gate: a site being admitted shows its outcome so far', () => {
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
		expect(lane(f, 'codex').gate).toMatchObject({ state: 'active', value: 3, of: 431, outcome: { new: 1, joined: 1, failed: 1 } });
		expect(lane(f, 'fprints').gate).toMatchObject({ state: 'todo', text: 'waiting its turn' });
		expect(lane(f, 'factorioprints').gate.state).toBe('done');
		// Once fprints' admission starts, codex's is over (its figures come at the step's end).
		const later = logProgress(
			`== Update the site's prints\nprod ← codex inbox x: 2 records to admit\ncodex/1: new\ncodex/2: failed (x)\nprod ← fprints inbox y: 9 records to admit\nfprints/a: new\n`
		);
		const g = flowOf({ run: r, phase: 'running', progress: later });
		expect(lane(g, 'codex').gate.state).toBe('warn');
		expect(lane(g, 'fprints').gate).toMatchObject({ state: 'active', value: 1, of: 9 });
	});

	test('render: the render run’s own progress, shared by every source', () => {
		const r = structuredClone(RUN);
		r.state = 'running';
		r.steps = r.steps.map((s) =>
			s.id === 'render' ? { ...s, status: 'running', summary: undefined } : s.id === 'figures' ? { id: s.id, status: 'pending' } : s
		);
		const liveRender = { prints_total: 28, prints_done: 12, rendered: 70, uploaded: 64, failed: 0, eta_seconds: 300 } as RenderRun;
		const f = flowOf({ run: r, phase: 'running', liveRender });
		expect(f.render).toMatchObject({ state: 'active', value: 12, of: 28 });
		expect(f.render.figs?.some((x) => x.label === 'pages drawn' && x.value === 70)).toBe(true);
	});

	describe('render: after the last page, the phase the log names', () => {
		const running = () => {
			const r = structuredClone(RUN);
			r.state = 'running';
			r.steps = r.steps.map((s) =>
				s.id === 'render'
					? { ...s, status: 'running', summary: undefined, details: undefined }
					: s.id === 'figures'
						? { id: s.id, status: 'pending' }
						: s
			);
			return r;
		};
		// The run of 2026-10-30 22:46: every page drawn and uploaded, thumbnails still going.
		const allDrawn = {
			prints_total: 50,
			prints_done: 50,
			rendered: 451,
			uploaded: 451,
			failed: 0,
			uploads_pending: 0,
			eta_seconds: null
		} as RenderRun;
		const LOG = `== Render and upload
run 2026-10-30T22:46:02Z-es1r: --next 50 --top 1000 --upload prod --flags --workers 4
queued 451 pages of 454 (0 unchanged, 3 skipped, 0 failed) from 52 prints in 6.9 s
`;
		const at = (lines: string, liveRender: RenderRun | null = allDrawn) => {
			const run = running();
			const progress = logProgress(LOG + lines);
			const f = flowOf({ run, phase: 'running', liveRender, progress });
			return { f, sentence: nowSentence(f, { plan: BEFORE, run, phase: 'running', liveRender }) };
		};

		test('drawing: the run row, as before (the log has said nothing more yet)', () => {
			const { f, sentence } = at('', { ...allDrawn, prints_done: 31 });
			expect(f.renderNow).toMatchObject({ phase: 'drawing', value: 31, of: 50 });
			expect(sentence).toBe('Drawing prints: 31 of 50.');
		});

		test('thumbnails: prints made and uploaded of those offered, not the finished-looking page counts', () => {
			const { f, sentence } = at(
				"rendering done; bringing 13 prints' thumbnails up to date\nthumbnails: 37 of 50 prints made and uploaded\n"
			);
			expect(f.render).toMatchObject({ state: 'active', value: 37, of: 50, text: 'prints’ thumbnails made and uploaded' });
			expect(f.render.figs).toEqual([
				{ label: 'pages drawn', value: 451 },
				{ label: 'uploaded', value: 451 }
			]);
			expect(f.renderNow).toMatchObject({ label: 'Making and uploading thumbnails', unit: 'prints' });
			expect(sentence).toBe('Making and uploading thumbnails: 37 of 50 prints.');
		});

		test('the last uploads, then deletions', () => {
			expect(at('rendering done; waiting for 3 pages to upload\n', { ...allDrawn, uploads_pending: 2 }).sentence).toBe(
				'Uploading the last 2 pages.'
			);
			const { f, sentence } = at('deletions: deleting replaced files whose grace period is over\n');
			expect(f.render).toMatchObject({ state: 'active', text: 'removing replaced files' });
			expect(f.render.of).toBeUndefined();
			expect(sentence).toBe('Removing replaced files from the bucket.');
		});

		test('flags: the run row is final (no live run), its end line gives the figures', () => {
			const end =
				'finished: 454/454 pages (50/50 prints), 451 rendered, 0 unchanged, 3 skipped, 0 failed; 21814 files, 1043.2 MB in 1820 s\n' +
				'uploads: 451 pages, 21814 files, 1043.2 MB, 0 deleted; 0 deletions scheduled / 0 pending; 0 pages still to upload\n';
			const { f, sentence } = at(end + 'flags: render:flags --stage prod, and a page-cache bump\n', null);
			expect(f.render).toMatchObject({ state: 'active', text: 'updating search flags on prod' });
			expect(f.render.figs).toEqual([
				{ label: 'pages drawn', value: 451 },
				{ label: 'uploaded', value: 451 }
			]);
			expect(sentence).toBe('Updating search flags on prod.');
			const failed = at(end + 'flags: render:flags --stage prod\nflags: failed: remote /d1: Network connection lost.\n', null);
			expect(failed.f.render.state).toBe('warn');
			expect(failed.sentence).toBe('Setting the search flags on prod failed: run render:flags by hand.');
		});

		test('no render run yet: picking', () => {
			const run = running();
			const f = flowOf({ run, phase: 'running', progress: logProgress('== Render and upload\n$ bun scripts/render-scope.ts top 1000\n') });
			expect(f.render).toMatchObject({ state: 'active', text: 'picking the prints with work' });
			expect(nowSentence(f, { plan: BEFORE, run, phase: 'running', liveRender: null })).toBe('Picking the prints to render.');
		});
	});
});
