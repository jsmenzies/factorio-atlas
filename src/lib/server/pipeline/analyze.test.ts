import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { fixtureRecord } from '#lib/server/fixtures.js';
import { analyzePrint } from './analyze';
import { decodeExchangeString } from './decode';
import { facetTokens } from './repository';

/** Packed game versions, as exchange strings store them. */
const V2_0_77 = 2 * 2 ** 48 + 77 * 2 ** 16;
const V1_1_0 = 2 ** 48 + 2 ** 32;

const at = (x: number) => ({ x: x + 0.5, y: 0.5 });
const modules = (name: string, quality: string, count: number) => ({
	id: { name, quality },
	items: { in_inventory: Array.from({ length: count }, (_, i) => ({ inventory: 4, stack: i })) }
});

const blueprint = (entities: object[], tiles: object[] = [], version = V2_0_77) => ({
	blueprint: {
		version,
		entities: entities.map((e, i) => ({ entity_number: i + 1, position: at(i * 4), ...e })),
		tiles
	}
});

describe('quality counts', () => {
	const a = analyzePrint(
		blueprint([
			{ name: 'crusher', quality: 'uncommon' },
			{ name: 'crusher', quality: 'uncommon' },
			{ name: 'crusher' },
			{ name: 'assembling-machine-3', quality: 'rare', recipe: 'iron-gear-wheel', items: [modules('speed-module-3', 'legendary', 4)] }
		])
	);

	test('entitiesByQuality splits each entity by quality; entities keeps the totals', () => {
		expect(a.entitiesByQuality).toEqual({ 'crusher@uncommon': 2, 'assembling-machine-3@rare': 1, crusher: 1 });
		expect(a.entities).toEqual({ crusher: 3, 'assembling-machine-3': 1 });
		expect(a.nodes[0].entitiesByQuality).toEqual(a.entitiesByQuality);
	});

	test('module quality counts as quality too', () => {
		expect(a.modules).toEqual({ 'speed-module-3@legendary': 4 });
		expect(a.qualities).toEqual({ uncommon: 2, rare: 1, legendary: 4 });
		expect(a.usesQuality).toBe(true);
	});

	test('every quality above normal is a search token', () => {
		const tokens = facetTokens({ tags: [] }, a);
		expect(tokens.filter((t) => t.startsWith('quality_')).sort()).toEqual(['quality_legendary', 'quality_rare', 'quality_uncommon']);
		expect(facetTokens({ tags: [] }, analyzePrint(blueprint([{ name: 'crusher' }]))).some((t) => t.startsWith('quality_'))).toBe(false);
	});

	test("a book's counts add up its pages", () => {
		const book = analyzePrint({
			blueprint_book: {
				version: V2_0_77,
				blueprints: [
					{ index: 0, ...blueprint([{ name: 'crusher', quality: 'uncommon' }]) },
					{ index: 1, ...blueprint([{ name: 'crusher', quality: 'uncommon' }, { name: 'crusher' }]) }
				]
			}
		});
		expect(book.entitiesByQuality).toEqual({ 'crusher@uncommon': 2, crusher: 1 });
	});
});

describe('icons', () => {
	test("a 1.x book's own icons get their 2.0 names, like its pages' icons", () => {
		const icon = { index: 1, signal: { type: 'item', name: 'stack-inserter' } };
		const a = analyzePrint({
			blueprint_book: {
				version: V1_1_0,
				icons: [icon],
				blueprints: [{ index: 0, blueprint: { version: V1_1_0, icons: [icon], entities: [] } }]
			}
		});
		expect(a.nodes.map((n) => n.icons)).toEqual([['item:bulk-inserter'], ['item:bulk-inserter']]);
	});
});

describe('a real space platform', () => {
	// "Calcite collector platform (protected)": quality entities on 2,029 platform foundations.
	test('counts its foundations and its quality entities', async () => {
		const record = JSON.parse(await fixtureRecord('-OBuERtPdm2_2an2RSMS')) as { blueprintString: string };
		const a = analyzePrint(await Effect.runPromise(decodeExchangeString(record.blueprintString)));
		expect(a.tiles).toEqual({ 'space-platform-foundation': 2029 });
		expect(a.entities.crusher).toBe(13);
		expect(a.entitiesByQuality).toMatchObject({ 'crusher@uncommon': 12, crusher: 1, 'solar-panel@uncommon': 33, 'cargo-bay@rare': 3 });
		expect(Object.values(a.entitiesByQuality).reduce((s, n) => s + n, 0)).toBe(a.entityCount);
	});
});
