import { describe, expect, test } from 'bun:test';
import type { ScopeFigures } from '#lib/server/admin/render-scope.js';
import { DEFAULT_SETTINGS, freshSteps, type SourcePlan, type SyncPlan, type SyncRun } from '#lib/sync.js';
import { previewSteps, renderWork, sourceState, unchecked, updateState, upToDateLine } from './view';

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

describe('a source whose cursor isn’t a commit (uploads)', () => {
	const uploads = (added: number): SourcePlan =>
		source({
			site: 'uploads',
			kind: 'uploads on the site',
			ingestsItself: true,
			from: { id: 'none', date: 0 },
			to: added ? { id: `${added}-abc`, date: 0 } : { id: 'none', date: 0 },
			added,
			edited: 0,
			favourites: 0,
			deleted: [],
			modern: 0,
			position: added ? `${added} waiting, oldest 30 Oct, 11:02` : 'none waiting',
			stateText: added ? `${added} waiting` : undefined
		});
	test('says what waits in its own words; the mirror reads as before', () => {
		expect(sourceState(uploads(3))).toEqual({ text: '3 waiting', tone: 'warn' });
		expect(sourceState(uploads(0))).toEqual({ text: 'up to date', tone: 'ok' });
		expect(sourceState(source({ behind: 2 }))).toEqual({ text: '2 commits behind · 46 new, 4 edited', tone: 'warn' });
		expect(sourceState({ ...uploads(0), error: 'the prod D1 database has no uploads table' })).toEqual({
			text: 'couldn’t check',
			tone: 'bad'
		});
	});
	test('waiting uploads are fetch work, never prints for the ingest step to analyse', () => {
		const steps = previewSteps(plan(level, [uploads(3)]), union(0), DEFAULT_SETTINGS);
		expect(steps[1]).toEqual({ id: 'fetch', text: 'uploads: 3 waiting', idle: false });
		expect(steps[2].idle).toBe(true);
		expect(steps[4].text).toBe('copy any new screenshots from Imgur');
		const both = previewSteps(plan({}, [uploads(3)]), union(0), DEFAULT_SETTINGS);
		expect(both[1].text).toBe('+46 new, 4 edited, 212 only favourite counts changed, 1 deleted; uploads: 3 waiting');
		expect(both[2].text).toContain('analyse 50 new and edited prints');
	});
});

describe('upToDateLine', () => {
	const level = (site: string, over: Partial<SourcePlan> = {}) =>
		source({ site, from: { id: 'a', date: 0 }, to: { id: 'a', date: 0 }, ...over });
	test('every source checked: up to date with all of them', () => {
		expect(upToDateLine({ checkedAt: 0, sources: [level('factorioprints'), level('uploads'), level('codex')] })).toEqual({
			text: 'with all 3 sources',
			complete: true
		});
		expect(upToDateLine({ checkedAt: 0, sources: [level('factorioprints')] }).text).toBe('with its source');
	});

	test("a source that couldn't be checked is never up to date, and is named", () => {
		const sources = [level('factorioprints'), level('uploads'), level('codex', { error: 'HTTP 522', polled: true })];
		expect(updateState(null, { checkedAt: 0, sources }, 0)).toBe('current');
		expect(upToDateLine({ checkedAt: 0, sources })).toEqual({
			text: '2 of 3 sources up to date · codex couldn’t be checked',
			complete: false
		});
		const two = [...sources, level('fprints', { error: 'timeout', polled: true })];
		expect(upToDateLine({ checkedAt: 0, sources: two }).text).toBe('2 of 4 sources up to date · codex and fprints couldn’t be checked');
		expect(unchecked({ checkedAt: 0, sources: two }).map((p) => p.site)).toEqual(['codex', 'fprints']);
	});

	test('sources turned off are not counted', () => {
		const sources = [level('factorioprints'), level('fprints', { off: true, polled: true }), level('codex', { error: 'HTTP 522' })];
		expect(upToDateLine({ checkedAt: 0, sources }).text).toBe('1 of 2 sources up to date · codex couldn’t be checked');
	});
});
