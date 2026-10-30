import { describe, expect, test } from 'bun:test';
import { isLiveSync } from './server/sync';
import { DEFAULT_SETTINGS, estimateRender, parseSettings, planTotals, sourceDigest, type SourcePlan } from './sync';

describe('parseSettings', () => {
	test('nothing stored: the defaults', () => {
		expect(parseSettings(undefined)).toEqual({ settings: DEFAULT_SETTINGS, errors: [] });
		expect(DEFAULT_SETTINGS).toMatchObject({ top: 1000, perUpdate: 500, authors: true, authorLimit: 50, maxChange: 0.05 });
	});

	test('valid fields kept, invalid ones named and replaced by the default', () => {
		const { settings, errors } = parseSettings({ top: 2000, perUpdate: null, workers: 0, imgurRecheck: 'daily', screenshots: false });
		expect(settings).toMatchObject({ top: 2000, perUpdate: null, workers: null, imgurRecheck: 'never', screenshots: false });
		expect(errors.sort()).toEqual(['imgurRecheck', 'workers']);
	});

	test('top 0 means no top list', () => {
		expect(parseSettings({ top: 0 }).settings.top).toBe(0);
		expect(parseSettings({ top: 1.5 }).errors).toEqual(['top']);
	});
});

describe('polled sites', () => {
	test('codex is on by default, with room for the first full import', () => {
		expect(DEFAULT_SETTINGS.polled.codex).toEqual({ on: true, perUpdate: 1000 });
		// Settings saved before polled sites existed get the defaults.
		expect(parseSettings({ top: 5 }).settings.polled.codex).toEqual({ on: true, perUpdate: 1000 });
	});

	test('turned off, a cap kept; bad fields named', () => {
		expect(parseSettings({ polled: { codex: { on: false, perUpdate: 40 } } })).toMatchObject({
			settings: { polled: { codex: { on: false, perUpdate: 40 } } },
			errors: []
		});
		const bad = parseSettings({ polled: { codex: { on: 'yes', perUpdate: 0 } } });
		expect(bad.settings.polled.codex).toEqual({ on: true, perUpdate: 1000 });
		expect(bad.errors.sort()).toEqual(['polled.codex.on', 'polled.codex.perUpdate']);
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
