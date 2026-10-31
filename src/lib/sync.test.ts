import { describe, expect, test } from 'bun:test';
import { isLiveSync } from './server/sync';
import { DEFAULT_SETTINGS, estimateRender, parseSettings, HOLD_FLOOR, holdBack, planTotals, sourceDigest, type SourcePlan } from './sync';

describe('parseSettings', () => {
	test('nothing stored: the defaults', () => {
		expect(parseSettings(undefined)).toEqual({ settings: DEFAULT_SETTINGS, errors: [] });
		expect(DEFAULT_SETTINGS).toMatchObject({ top: 1000, perUpdate: 500, authors: true, maxChange: 0.05 });
	});

	test('valid fields kept, invalid ones named and replaced by the default', () => {
		const { settings, errors } = parseSettings({ top: 2000, perUpdate: null, workers: 0, screenshots: false });
		expect(settings).toMatchObject({ top: 2000, perUpdate: null, workers: null, screenshots: false });
		expect(errors).toEqual(['workers']);
	});

	test('an old saved imgurRecheck is ignored, like any unknown key', () => {
		const { settings, errors } = parseSettings({ imgurRecheck: 'weekly', top: 5 });
		expect(errors).toEqual([]);
		expect(settings).toEqual({ ...DEFAULT_SETTINGS, top: 5 });
		expect('imgurRecheck' in settings).toBe(false);
	});

	test('render on by default; turned off kept; settings saved before it existed render', () => {
		expect(DEFAULT_SETTINGS.render).toBe(true);
		expect(parseSettings({ render: false }).settings.render).toBe(false);
		expect(parseSettings({ top: 5 }).settings.render).toBe(true);
		expect(parseSettings({ render: 'no' }).errors).toEqual(['render']);
	});

	test('top 0 means no top list', () => {
		expect(parseSettings({ top: 0 }).settings.top).toBe(0);
		expect(parseSettings({ top: 1.5 }).errors).toEqual(['top']);
	});
});

describe('holdBack: one rule for every source', () => {
	const at5 = { maxChange: 0.05 };
	test('the floor: a small source is never held back for a normal day', () => {
		expect(HOLD_FLOOR).toBe(25);
		// 5% of 200 is 10, but up to 25 changes pass.
		expect(holdBack({ ...at5, added: 20, removed: 5, known: 200 })).toBeNull();
		expect(holdBack({ ...at5, added: 26, removed: 0, known: 200 })).toBe(
			"26 new, 0 removed: more than 5% (25 at least) of 200; check the site, then accept it if it's right"
		);
	});

	test('new only, removed only, and the mirror’s moves all count; past the share of a big source', () => {
		expect(holdBack({ ...at5, added: 62, removed: 3, known: 466, what: 'codex' })).toBe(
			"62 new, 3 removed: more than 5% (25 at least) of 466; check codex, then accept it if it's right"
		);
		expect(holdBack({ ...at5, added: 0, removed: 30, known: 466 })).not.toBeNull();
		expect(holdBack({ ...at5, added: 900, removed: 0, known: 18_000 })).toBeNull();
		expect(holdBack({ ...at5, added: 500, removed: 300, moved: 200, known: 18_000, what: 'the mirror' })).toBe(
			"500 new, 300 removed, 200 moved: more than 5% (25 at least) of 18,000; check the mirror, then accept it if it's right"
		);
	});

	test('edits never count (they aren’t an input); a first import is held back once; accepted goes through', () => {
		expect(holdBack({ ...at5, added: 0, removed: 0, known: 30 })).toBeNull();
		expect(holdBack({ ...at5, added: 3, removed: 0, known: 0 })).toBe(
			'3 new, 0 removed: a first import; check the site, then accept it to import them'
		);
		expect(holdBack({ ...at5, added: 0, removed: 0, known: 0 })).toBeNull();
		expect(holdBack({ ...at5, added: 3, removed: 0, known: 0, accepted: true })).toBeNull();
		expect(holdBack({ ...at5, added: 999, removed: 0, known: 10, accepted: true })).toBeNull();
	});
});

describe('polled sites', () => {
	test('codex and fprints are on by default; there is no read cap', () => {
		expect(DEFAULT_SETTINGS.polled).toEqual({ codex: { on: true }, fprints: { on: true } });
		expect(parseSettings({ polled: { fprints: { on: false } } }).settings.polled).toEqual({ codex: { on: true }, fprints: { on: false } });
		// Settings saved before polled sites existed get the defaults.
		expect(parseSettings({ top: 5 }).settings.polled.codex).toEqual({ on: true });
	});

	test('an old saved read cap is ignored, never an error; a bad switch is named', () => {
		expect(parseSettings({ polled: { codex: { on: false, perUpdate: 40 } } })).toEqual({
			settings: { ...DEFAULT_SETTINGS, polled: { codex: { on: false }, fprints: { on: true } } },
			errors: []
		});
		const bad = parseSettings({ polled: { codex: { on: 'yes', perUpdate: 0 } } });
		expect(bad.settings.polled.codex).toEqual({ on: true });
		expect(bad.errors).toEqual(['polled.codex.on']);
	});

	test("out of the backfill's ingest key, counted apart in the plan's totals", () => {
		expect(
			sourceDigest([
				{ site: 'factorioprints', from: null, to: { id: 'abc', date: 0 } },
				{ site: 'codex', from: null, to: { id: '456@1', date: 0 }, polled: true }
			])
		).toBe('factorioprints@abc');
		const base = { favourites: 0, modern: 0, blocked: null, prints: 0 };
		const sources: SourcePlan[] = [
			{ ...base, site: 'factorioprints', from: { id: 'a', date: 0 }, to: { id: 'a', date: 0 }, added: 0, edited: 0, deleted: [] },
			{ ...base, site: 'codex', polled: true, from: { id: 'x', date: 0 }, to: { id: 'y', date: 1 }, added: 3, edited: 2, deleted: ['9'] }
		];
		expect(planTotals({ checkedAt: 0, sources })).toMatchObject({ moved: true, backfill: false, added: 0, polled: 5 });
	});
});

describe('estimateRender', () => {
	test("1,000 prints: about today's averages", () => {
		const e = estimateRender(1000);
		expect(e.pages).toBe(11_000);
		expect(e.dollars).toBeCloseTo(2.72, 2);
		expect(e.seconds / 3600).toBeCloseTo(2.6, 1);
	});
});

describe('isLiveSync', () => {
	test('live while it beats; a live state without a heartbeat for a minute has crashed', () => {
		expect(isLiveSync({ state: 'running', updated_at: 1000 }, 30_000)).toBe(true);
		expect(isLiveSync({ state: 'running', updated_at: 1000 }, 120_000)).toBe(false);
		expect(isLiveSync({ state: 'finished', updated_at: 1000 }, 2000)).toBe(false);
	});
});
