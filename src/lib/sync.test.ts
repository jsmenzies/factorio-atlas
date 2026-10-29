import { describe, expect, test } from 'bun:test';
import { isLiveSync } from './server/sync';
import { DEFAULT_SETTINGS, estimateRender, parseSettings } from './sync';

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
