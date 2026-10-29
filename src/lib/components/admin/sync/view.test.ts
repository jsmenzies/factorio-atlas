import { describe, expect, test } from 'bun:test';
import type { ScopeFigures } from '#lib/server/admin/render-scope.js';
import { DEFAULT_SETTINGS, freshSteps, type SourcePlan, type SyncPlan, type SyncRun } from '#lib/sync.js';
import { previewSteps, renderWork, updateState } from './view';

const source = (over: Partial<SourcePlan> = {}): SourcePlan => ({
	site: 'factorioprints',
	from: { id: 'aaa', date: 0 },
	to: { id: 'bbb', date: 0 },
	prints: 18_000,
	added: 46,
	edited: 4,
	favourites: 212,
	deleted: ['-gone'],
	modern: 41,
	blocked: null,
	...over
});
const plan = (over: Partial<SourcePlan> = {}, more: SourcePlan[] = []): SyncPlan => ({ checkedAt: 0, sources: [source(over), ...more] });
const level = { to: { id: 'aaa', date: 0 } };
const run = (state: SyncRun['state'], updated_at: number): SyncRun => ({
	id: 'r',
	state,
	control: null,
	stage: 'prod',
	options: { settings: DEFAULT_SETTINGS, pid: 1, log: 'sync-x.log' },
	sources: [],
	steps: freshSteps(),
	started_at: 0,
	updated_at,
	finished_at: null,
	error: null
});
const union = (left: number): ScopeFigures => ({ total: 6000, rendered: 5400, uploaded: 5400, left, none: 500, failed: 1, updated: 0 });

describe('updateState', () => {
	test('a live update first; one without a heartbeat for a minute has crashed', () => {
		expect(updateState(run('running', 1000), plan(), 30_000)).toBe('running');
		expect(updateState(run('running', 1000), plan(), 120_000)).toBe('crashed');
	});
	test('then the sources: one held back, something waiting, or current', () => {
		expect(updateState(run('finished', 0), plan({ blocked: 'too much' }), 0)).toBe('blocked');
		expect(updateState(null, plan(), 0)).toBe('waiting');
		expect(updateState(null, plan(level), 0)).toBe('current');
		expect(updateState(null, null, 0)).toBe('current');
		// A second source with news makes the update waiting even when the first has none.
		expect(updateState(null, plan(level, [source({ site: 'other' })]), 0)).toBe('waiting');
	});
});

describe('renderWork', () => {
	test('new 2.0+ prints plus what is left, up to the per-update limit', () => {
		expect(renderWork(plan(), 5, DEFAULT_SETTINGS)).toBe(46);
		expect(renderWork(plan(), 900, DEFAULT_SETTINGS)).toBe(500);
		expect(renderWork(plan(), 900, { ...DEFAULT_SETTINGS, perUpdate: null })).toBe(941);
		expect(renderWork(plan(level), 5, DEFAULT_SETTINGS)).toBe(5);
		// A held-back source brings nothing.
		expect(renderWork(plan({ blocked: 'too much' }), 5, DEFAULT_SETTINGS)).toBe(5);
	});
});

describe('previewSteps', () => {
	test('one line per step; steps turned off say so', () => {
		const steps = previewSteps(plan(), union(5), { ...DEFAULT_SETTINGS, authors: false });
		expect(steps.map((s) => s.id)).toEqual(['removals', 'fetch', 'ingest', 'authors', 'screenshots', 'render', 'figures']);
		expect(steps[1].text).toBe('+46 new, 4 edited, 212 only favourite counts changed, 1 deleted');
		expect(steps[3]).toEqual({ id: 'authors', text: 'off in the settings', idle: true });
		expect(steps[5].text).toContain('render about 46 prints');
	});
	test('nothing new: fetch, ingest and render are idle', () => {
		const steps = previewSteps(plan(level), union(0), DEFAULT_SETTINGS);
		expect(steps[1].idle).toBe(true);
		expect(steps[2].idle).toBe(true);
		expect(steps[5].idle).toBe(true);
	});
	test('a held-back source is named in the fetch line', () => {
		expect(previewSteps(plan({ blocked: 'too much' }), union(0), DEFAULT_SETTINGS)[1].text).toBe(
			'nothing new to fetch; factorioprints held back'
		);
	});
});
