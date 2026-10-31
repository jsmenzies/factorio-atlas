import { describe, expect, test } from 'bun:test';
import { gaveUp, MAX_ATTEMPTS, planOnlyWrites, type JobWrite } from './queue.js';

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

describe('planOnlyWrites', () => {
	const write = (path: string, status: JobWrite['status']) => ({ path, status }) as JobWrite;
	const old = new Map([
		['1', { status: 'done' as const }],
		['2', { status: 'done' as const }],
		['3', { status: 'done' as const }],
		['4', { status: 'pending' as const }],
		['5', { status: 'skipped' as const }]
	]);

	test('drops every write that would move a done row to another status, and keeps the rest', () => {
		const writes = [
			write('1', 'pending'), // redrawn: the row stays done, as do its files and index entry
			write('2', 'skipped'), // now skipped: the same
			write('3', 'done'), // done again (another key or overview): kept
			write('4', 'skipped'),
			write('5', 'pending'),
			write('6', 'pending'), // a new page
			write('', 'failed') // a print whose record went: no row at '' before
		];
		expect(planOnlyWrites(writes, old).map((w) => `${w.path}:${w.status}`)).toEqual([
			'3:done',
			'4:skipped',
			'5:pending',
			'6:pending',
			':failed'
		]);
		expect(planOnlyWrites([write('', 'failed')], new Map([['', { status: 'done' as const }]]))).toEqual([]);
	});
});
