import { describe, expect, test } from 'bun:test';
import { gaveUp, MAX_ATTEMPTS } from './queue.js';

describe('gaveUp', () => {
	const row = { status: 'failed', attempts: MAX_ATTEMPTS, input_key: 'k1' } as const;

	test('a page that failed every attempt at the same key stays failed', () => {
		expect(gaveUp(row, 'k1')).toBe(true);
		expect(gaveUp(row)).toBe(true);
	});

	test('a new input key queues it again', () => {
		expect(gaveUp(row, 'k2')).toBe(false);
	});

	test('attempts left, or not failed, is still work', () => {
		expect(gaveUp({ ...row, attempts: MAX_ATTEMPTS - 1 }, 'k1')).toBe(false);
		expect(gaveUp({ ...row, attempts: 0 })).toBe(false);
		expect(gaveUp({ ...row, status: 'pending' }, 'k1')).toBe(false);
		expect(gaveUp({ ...row, status: 'done' })).toBe(false);
	});
});
