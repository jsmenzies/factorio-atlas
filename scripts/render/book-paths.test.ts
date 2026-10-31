import { describe, expect, test } from 'bun:test';
import { analyzePrint } from '#lib/server/pipeline/analyze.js';
import { bookEntryIndex } from '#lib/server/pipeline/decode.js';
import { fingerprintPrint } from '#lib/server/pipeline/identity.js';
import { listPages } from '#lib/viewer/extract.js';
import { blueprintPages } from './source.js';

const V2 = 562949954076672; // 2.0.10.0

const page = (label: string, index?: number) => ({
	...(index === undefined ? {} : { index }),
	blueprint: {
		item: 'blueprint',
		label,
		version: V2,
		entities: [{ entity_number: 1, name: 'assembling-machine-2', position: { x: 0.5, y: 0.5 }, recipe: 'iron-gear-wheel' }]
	}
});
const book = (blueprints: unknown[]) => ({ blueprint_book: { item: 'blueprint-book', label: 'Book', version: V2, blueprints } });

/** Every walker's blueprint page paths, in order. */
const walkers = async (decoded: unknown) => ({
	render: [...blueprintPages(decoded)].map((p) => p.path),
	viewer: listPages(decoded)
		.filter((p) => p.kind === 'blueprint')
		.map((p) => p.path),
	analysis: analyzePrint(decoded)
		.nodes.filter((n) => n.kind === 'blueprint')
		.map((n) => n.path),
	identity: (await fingerprintPrint(decoded)).pages.map((p) => p.path)
});

describe('bookEntryIndex', () => {
	test('the entry’s index, else its position in the book', () => {
		expect(bookEntryIndex({ index: 7 }, 2)).toBe(7);
		expect(bookEntryIndex({ index: 0 }, 2)).toBe(0);
		expect(bookEntryIndex({}, 2)).toBe(2);
		expect(bookEntryIndex({ index: '7' }, 2)).toBe(2);
		expect(bookEntryIndex(null, 3)).toBe(3);
	});
});

describe('book paths', () => {
	test('a book whose entries carry no index (as codex exports): one path per page, by position', async () => {
		const decoded = book([page('a'), page('b'), page('c'), book([page('d'), page('e')])]);
		const want = ['0', '1', '2', '3/0', '3/1'];
		for (const paths of Object.values(await walkers(decoded))) expect(paths).toEqual(want);
	});

	test('indexed entries keep their index, unindexed ones take their position', async () => {
		const decoded = book([page('a', 5), page('b', 9), page('c'), page('d', 0)]);
		for (const paths of Object.values(await walkers(decoded))) expect(paths).toEqual(['5', '9', '2', '0']);
	});
});
