import { describe, expect, test } from 'bun:test';
import { cardVersion, isNewPrint, NEW_FOR_MS, versionChoices } from './card-tags';

describe('cardVersion', () => {
	test('the newest of the saved and claimed versions, as major.minor', () => {
		expect(cardVersion('2.1.21', ['1.0', '2.0', '2.1'], '2.1.23')).toEqual({ label: '2.1', saved: '2.1.21', latest: true });
		expect(cardVersion('1.1.110', ['0.17', '2.0'], '2.1.23')).toEqual({ label: '2.0', saved: '1.1.110', latest: false });
		expect(cardVersion('0.16.51', ['0.15'], '2.1.23')).toEqual({ label: '0.16', saved: '0.16.51', latest: false });
	});
	test('compares numbers, not strings', () => {
		expect(cardVersion('0.9.1', ['0.16', '0.10'], '2.1.23')?.label).toBe('0.16');
		expect(cardVersion('0.18.47', ['1.0'], '2.1.23')?.label).toBe('1.0');
	});
	test('a claimed full version counts by its major.minor', () => {
		expect(cardVersion('2.0.72', ['2.1.11'], '2.1.23')).toEqual({ label: '2.1', saved: '2.0.72', latest: true });
	});
	test('claims only, or nothing usable', () => {
		expect(cardVersion(null, ['1.1'], '2.1.23')).toEqual({ label: '1.1', saved: null, latest: false });
		expect(cardVersion(null, [], '2.1.23')).toBeNull();
		expect(cardVersion('x', ['2'], '2.1.23')).toBeNull();
	});
	test('past the game data counts as latest too', () => {
		expect(cardVersion('2.2.0', [], '2.1.23')?.latest).toBe(true);
	});
});

describe('isNewPrint', () => {
	const now = Date.UTC(2026, 9, 30, 12);
	test('new for two days after it was first posted', () => {
		expect(isNewPrint(now - 60_000, now)).toBe(true);
		expect(isNewPrint(now - NEW_FOR_MS + 1, now)).toBe(true);
		expect(isNewPrint(now - NEW_FOR_MS, now)).toBe(false);
		expect(isNewPrint(Date.UTC(2017, 0, 1), now)).toBe(false);
	});
	test('no date is never new', () => {
		expect(isNewPrint(null, now)).toBe(false);
	});
});

describe('versionChoices', () => {
	test('newest first, from the game data down', () => {
		expect(versionChoices('2.1.23')).toEqual(['2.1', '2.0', '1.1', '1.0', '0.18', '0.17', '0.16', '0.15']);
		expect(versionChoices('2.2.0')[0]).toBe('2.2');
		expect(versionChoices('2.2.0')[1]).toBe('2.1');
		expect(versionChoices('2.0.77')[0]).toBe('2.0');
	});
});
