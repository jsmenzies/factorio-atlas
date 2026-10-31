import { describe, expect, test } from 'bun:test';
import { duplicateGuard, formatEntry, originalPath, parseState, planWork, type StateEntry, type Wanted } from './state.js';

const entry = (id: string, status: StateEntry['status'], over: Partial<StateEntry> = {}): StateEntry => ({
	id,
	status,
	prints: ['-AAAAAAAAAAAAAAAAAAA'],
	labelled: 'image/png',
	attempts: 1,
	at: '2026-10-24T00:00:00.000Z',
	...(status === 'fetched' ? { file: originalPath(id, 'png'), type: 'png', md5: 'm', bytes: 1 } : {}),
	...over
});
const want = (id: string): Wanted => ({ id, prints: ['-AAAAAAAAAAAAAAAAAAA'], labelled: 'image/png' });

describe('parseState', () => {
	test('the last line per id wins; a cut-off line is skipped', () => {
		const text =
			formatEntry(entry('a1', 'failed', { reason: 'HTTP 503' })) +
			formatEntry(entry('b2', 'dead')) +
			formatEntry(entry('a1', 'fetched')) +
			'{"id":"c3","status":"fetch';
		const { entries, bad } = parseState(text);
		expect(bad).toBe(1);
		expect([...entries.keys()]).toEqual(['a1', 'b2']);
		expect(entries.get('a1')?.status).toBe('fetched');
	});

	test('empty, and lines that aren’t entries', () => {
		expect(parseState('').entries.size).toBe(0);
		expect(parseState('\n{"id":"x","status":"weird"}\n[]\n').bad).toBe(2);
	});
});

describe('planWork', () => {
	const state = new Map(
		[entry('done', 'fetched'), entry('gone', 'fetched'), entry('dead', 'dead'), entry('fail', 'failed')].map((e) => [e.id, e] as const)
	);
	const wanted = ['new', 'done', 'gone', 'dead', 'fail'].map(want);
	const hasFile = (e: StateEntry) => e.id !== 'gone';

	test('skips fetched files that exist and dead ids; fetches new, failed and files that went missing', () => {
		const plan = planWork(wanted, state, { recheckDead: false, hasFile });
		expect(plan.todo.map((w) => w.id)).toEqual(['new', 'gone', 'fail']);
		expect(plan).toMatchObject({ done: 1, dead: 1, missing: 1, retrying: 1, recheck: 0 });
	});

	test('--recheck-dead asks again about dead ids', () => {
		const plan = planWork(wanted, state, { recheckDead: true, hasFile });
		expect(plan.todo.map((w) => w.id)).toEqual(['new', 'gone', 'dead', 'fail']);
		expect(plan).toMatchObject({ dead: 0, recheck: 1 });
	});
});

test('duplicateGuard trips when one MD5 reaches maxIds ids', () => {
	const g = duplicateGuard(4);
	g.add('x', 'a');
	g.add('x', 'b');
	expect(g.check('x', 'c')).toEqual({ others: ['a', 'b'], tripped: false });
	g.add('x', 'c');
	expect(g.check('x', 'd').tripped).toBe(true);
	// The same id again (a refetch) isn't a duplicate of itself.
	expect(g.check('x', 'a')).toEqual({ others: ['b', 'c'], tripped: false });
	expect(g.check('y', 'd').tripped).toBe(false);
});

test('duplicateGuard allows a series of re-uploads by default, and counts them', () => {
	const g = duplicateGuard();
	for (const id of ['a', 'b', 'c', 'd']) {
		expect(g.check('font', id).tripped).toBe(false);
		g.add('font', id);
	}
	g.add('other', 'e');
	g.add('pair', 'f');
	g.add('pair', 'g');
	expect(g.repeated()).toEqual({ sets: 2, ids: 6, largest: 4 });
	for (let i = 0; i < 20; i++) g.add('font', `s${i}`);
	expect(g.check('font', 'z').tripped).toBe(true);
	expect(duplicateGuard().repeated()).toEqual({ sets: 0, ids: 0, largest: 0 });
});

test('originalPath', () => {
	expect(originalPath('8B9jpx6', 'jpg')).toBe('originals/8B/8B9jpx6.jpg');
});

test('planWork never fetches a removed image again', () => {
	const removed = entry('rmv', 'removed', { reason: 'taken down on request' });
	const plan = planWork([want('rmv')], new Map([['rmv', removed]]), { recheckDead: true, hasFile: () => false });
	expect(plan.todo).toEqual([]);
	expect(plan.removed).toBe(1);
	expect(parseState(formatEntry(removed)).entries.get('rmv')?.status).toBe('removed');
});

test('old lines with fields no longer written (a removal’s `by`) still parse', () => {
	const line = `${JSON.stringify({ id: 'old', status: 'removed', prints: [], labelled: null, attempts: 1, at: '', by: 'imgur' })}\n`;
	expect(parseState(line).entries.get('old')?.status).toBe('removed');
	expect(parseState(line).bad).toBe(0);
});
