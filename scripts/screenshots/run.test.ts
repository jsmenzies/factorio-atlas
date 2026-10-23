import { expect, test } from 'bun:test';
import { selectEntries, tooManyGone } from './run.js';
import type { StateEntry } from './state.js';

const e = (id: string, status: StateEntry['status'], prints = ['-AAAAAAAAAAAAAAAAAAA']): StateEntry => ({
	id,
	status,
	prints,
	labelled: null,
	attempts: 1,
	at: ''
});

test('selectEntries: by Imgur or print id, kept, then capped', () => {
	const all = [e('a', 'fetched'), e('b', 'dead'), e('c', 'fetched', ['-BBBBBBBBBBBBBBBBBBB']), e('d', 'fetched')];
	const fetched = (x: StateEntry) => x.status === 'fetched';
	expect(selectEntries(all, null, null, fetched).map((x) => x.id)).toEqual(['a', 'c', 'd']);
	expect(selectEntries(all, null, 2, fetched).map((x) => x.id)).toEqual(['a', 'c']);
	expect(selectEntries(all, ['-BBBBBBBBBBBBBBBBBBB', 'b'], null, () => true).map((x) => x.id)).toEqual(['b', 'c']);
});

test('tooManyGone: a few deletions are believed, a mass of them is not', () => {
	expect(tooManyGone(3, 18_000)).toBe(false);
	expect(tooManyGone(50, 100)).toBe(false);
	expect(tooManyGone(51, 100)).toBe(true);
	expect(tooManyGone(400, 18_000)).toBe(false);
	expect(tooManyGone(1000, 18_000)).toBe(true);
	expect(tooManyGone(60, 18_000)).toBe(false);
});
