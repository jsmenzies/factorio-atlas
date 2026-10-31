import { describe, expect, test } from 'bun:test';
import { MAX_ATTEMPTS } from './queue.js';
import { batchCandidates, byPrint, leftOutLine, type BatchRow, type BatchState } from './scope.js';
import type { UploadRow } from './upload.js';

const row = (print_id: string, over: Partial<BatchRow> = {}): BatchRow => ({
	print_id,
	path: '',
	status: 'done',
	reason: null,
	attempts: 1,
	stamp: 'abc',
	finished_at: 100,
	...over
});
const up = (print_id: string, over: Partial<UploadRow> = {}): UploadRow => ({
	target: 'prod',
	print_id,
	path: '',
	stamp: 'abc',
	rendered_at: null,
	stale: 0,
	files: 1,
	bytes: 1,
	uploaded_at: 200,
	error: null,
	failed_at: null,
	...over
});

/** Every print seen at stamp s1 and unchanged, unless a test says otherwise. */
const state = (ids: string[], over: Partial<BatchState> = {}): BatchState => ({
	rows: new Map(),
	seen: new Map(ids.map((id) => [id, 's1'])),
	stamps: new Map(ids.map((id) => [id, 's1'])),
	uploads: null,
	top: [],
	retryFailed: false,
	...over
});

describe('batchCandidates', () => {
	test('prints never looked at, or whose record changed, in the order given', () => {
		const ids = ['a', 'b', 'c', 'd'];
		const s = state(ids);
		s.seen.delete('c');
		s.stamps.set('a', 's2');
		expect(batchCandidates(ids, s)).toEqual({ candidates: ['a', 'c'], unseen: 2 });
	});

	test('rows with work: pending, rendering, failed with attempts left', () => {
		const ids = ['p', 'r', 'f', 'g', 'd', 's'];
		const rows = byPrint([
			row('p', { status: 'pending' }),
			row('r', { status: 'rendering' }),
			row('f', { status: 'failed', attempts: 1 }),
			row('g', { status: 'failed', attempts: MAX_ATTEMPTS }),
			row('d'),
			row('s', { status: 'skipped', reason: 'empty' })
		]);
		expect(batchCandidates(ids, state(ids, { rows })).candidates).toEqual(['p', 'r', 'f']);
		// --retry-failed: any failed print counts, and failed prints come first.
		expect(batchCandidates(ids, state(ids, { rows, retryFailed: true })).candidates).toEqual(['f', 'g', 'p', 'r']);
	});

	test('--retry-failed takes failed prints before new work, so a batch of one redraws the failed print', () => {
		const ids = ['-new1', '-new2', 'codex-230', 'codex-231'];
		const s = state(ids, {
			rows: byPrint([
				row('codex-230', { status: 'failed', attempts: MAX_ATTEMPTS }),
				row('codex-230', { path: '1' }),
				row('codex-231', { status: 'pending' })
			]),
			top: ['-new2']
		});
		s.seen.delete('-new1');
		s.seen.delete('-new2');
		expect(batchCandidates(ids, s).candidates).toEqual(['-new1', '-new2', 'codex-231']);
		const retry = batchCandidates(ids, { ...s, retryFailed: true });
		expect(retry.candidates).toEqual(['codex-230', '-new1', '-new2', 'codex-231']);
		expect(retry.candidates[0]).toBe('codex-230');
		expect(retry.unseen).toBe(2);
	});

	test('with --upload, rendered pages not up at their stamp', () => {
		const ids = ['up', 'behind', 'none'];
		const rows = byPrint([row('up'), row('behind'), row('none')]);
		const uploads = byPrint([up('up'), up('behind', { stamp: 'old' })]);
		expect(batchCandidates(ids, state(ids, { rows })).candidates).toEqual([]);
		expect(batchCandidates(ids, state(ids, { rows, uploads })).candidates).toEqual(['behind', 'none']);
	});

	test('top-list prints with no rows or pages skipped pre-2.0', () => {
		const ids = ['t1', 't2', 't3', 'x'];
		const rows = byPrint([row('t2', { status: 'skipped', reason: 'pre-2.0' }), row('t3')]);
		expect(batchCandidates(ids, state(ids, { rows, top: ['t1', 't2', 't3'] })).candidates).toEqual(['t1', 't2']);
		expect(batchCandidates(ids, state(ids, { rows })).candidates).toEqual([]);
	});
});

test('byPrint keeps the order rows came in', () => {
	const m = byPrint([row('a', { path: '1' }), row('b'), row('a', { path: '2' })]);
	expect([...m.keys()]).toEqual(['a', 'b']);
	expect(m.get('a')!.map((r) => r.path)).toEqual(['1', '2']);
});

describe('leftOutLine', () => {
	test('planner-only prints are counted apart from pre-2.0 ones', () => {
		expect(leftOutLine({ prints: 4, pages: 196 }, 1)).toBe(
			'4 prints (196 pages) with no 2.0+ page and 1 with no blueprint pages (planners only) left out'
		);
	});
	test('without planner-only prints the line reads as before', () => {
		expect(leftOutLine({ prints: 5, pages: 196 }, 0)).toBe('5 prints (196 pages) with no 2.0+ page left out');
	});
});
