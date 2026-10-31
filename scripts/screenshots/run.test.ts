import { expect, test } from 'bun:test';
import { selectEntries } from './run.js';
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
