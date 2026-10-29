import { describe, expect, test } from 'bun:test';
import type { BlockRow } from '#lib/server/removal-blocks.js';
import { blockChanges, imageBlocks, liveRun, printPaths, unswept } from './plan';

const block = (kind: BlockRow['kind'], value: string, print_id = 'p'): BlockRow => ({
	kind,
	value,
	print_id,
	report_id: null,
	created_at: 1
});

describe('blockChanges', () => {
	test('adds what the stage has and drops what it no longer has', () => {
		const stage = [block('print', 'a'), block('source', 'factorioprints:a'), block('print', 'b')];
		const local = [block('print', 'a'), block('print', 'gone')];
		const c = blockChanges(stage, local);
		expect(c.add.map((b) => b.value)).toEqual(['factorioprints:a', 'b']);
		expect(c.drop.map((b) => b.value)).toEqual(['gone']);
	});

	test('the same kind and value is the same block, whoever wrote it', () => {
		expect(blockChanges([block('image', 'X', 'p1')], [block('image', 'X', 'p2')])).toEqual({ add: [], drop: [] });
	});
});

test('imageBlocks: every image block with its print', () => {
	expect(imageBlocks([block('print', 'a', 'a'), block('image', 'Img1', 'a')])).toEqual([{ image: 'Img1', print: 'a' }]);
});

test('liveRun: a live state with a fresh heartbeat', () => {
	const now = 1_000_000;
	expect(liveRun([{ id: 'r1', state: 'finished' as const, updated_at: now }], now)).toBeNull();
	expect(liveRun([{ id: 'r2', state: 'running' as const, updated_at: now - 60_000 }], now)).toBeNull();
	expect(liveRun([{ id: 'r3', state: 'paused' as const, updated_at: now - 1_000 }], now)?.id).toBe('r3');
});

test('printPaths: renders, thumbnails and the archived record', () => {
	expect(printPaths('-A', { renders: '/r', thumbs: '/t', raw: '/d' })).toEqual(['/r/-A', '/t/-A', '/d/factorioprints/-A.json']);
});

test('unswept: new tombstones and ones deleted again since the sweep', () => {
	const tombs = [
		{ print_id: 'a', kind: 'takedown', at: 5 },
		{ print_id: 'b', kind: 'gone', at: 9 },
		{ print_id: 'c', kind: 'gone', at: 3 }
	];
	expect(
		unswept(tombs, [
			{ print_id: 'a', tomb_at: 5 },
			{ print_id: 'b', tomb_at: 4 }
		]).map((t) => t.print_id)
	).toEqual(['b', 'c']);
});
