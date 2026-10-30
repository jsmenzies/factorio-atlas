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
});
