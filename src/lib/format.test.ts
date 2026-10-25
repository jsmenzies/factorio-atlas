import { describe, expect, test } from 'bun:test';
import { formatRate } from './format.js';

describe('formatRate', () => {
	test('per second by default, up to two decimals', () => {
		expect(formatRate(1.5)).toBe('1.5/s');
		expect(formatRate(15)).toBe('15/s');
		expect(formatRate(611.8399)).toBe('611.84/s');
		expect(formatRate(1 / 3)).toBe('0.33/s');
	});

	test('per minute is the same rate times 60, up to one decimal', () => {
		expect(formatRate(1.5, 'min')).toBe('90/min');
		expect(formatRate(0.75, 'min')).toBe('45/min');
		expect(formatRate(1 / 3, 'min')).toBe('20/min');
		expect(formatRate(0.123, 'min')).toBe('7.4/min');
	});

	test('a label stored as per minute shows as written', () => {
		// parseRate keeps "45/min" as 0.75/s.
		expect(formatRate(45 / 60, 'min')).toBe('45/min');
		expect(formatRate(45 / 60)).toBe('0.75/s');
	});

	test('below 1, two significant figures instead of rounding to nothing', () => {
		expect(formatRate(0.025)).toBe('0.025/s');
		expect(formatRate(0.0123)).toBe('0.012/s');
		expect(formatRate(0.005, 'min')).toBe('0.3/min');
		expect(formatRate(0.001)).toBe('0.001/s');
	});

	test('large rates get thousands separators', () => {
		expect(formatRate(611.84, 'min')).toBe('36,710.4/min');
		expect(formatRate(2500)).toBe('2,500/s');
	});

	test('no float noise', () => {
		expect(formatRate(0.1 + 0.2)).toBe('0.3/s');
		expect(formatRate((0.1 + 0.2) / 60, 'min')).toBe('0.3/min');
	});
});
