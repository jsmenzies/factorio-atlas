import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { fixtureRecord } from '#lib/server/fixtures.js';
import { analyzePrint, parseRate } from './analyze';
import { decodeExchangeString } from './decode';
import { facetText, facetTokens } from './repository';

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

	test('what machines craft, by the quality they craft at; fluids have none', () => {
		const crafted = analyzePrint(
			blueprint([
				{ name: 'assembling-machine-3', recipe: 'iron-gear-wheel', recipe_quality: 'rare' },
				{ name: 'assembling-machine-3', recipe: 'iron-gear-wheel', recipe_quality: 'rare' },
				{ name: 'assembling-machine-3', recipe: 'iron-gear-wheel' },
				{ name: 'chemical-plant', recipe: 'sulfuric-acid', recipe_quality: 'epic' }
			])
		);
		expect(crafted.productsByQuality).toEqual({ 'item:iron-gear-wheel@rare': 2, 'item:iron-gear-wheel': 1 });
		expect(crafted.qualities).toEqual({ rare: 2, epic: 1 });
	});

	test('each entity, module and crafted item at a quality is a search token of its own', () => {
		const crafted = analyzePrint(
			blueprint([{ name: 'assembling-machine-3', quality: 'rare', recipe: 'iron-gear-wheel', recipe_quality: 'epic' }])
		);
		const at = (x: typeof a) => facetTokens({ tags: [] }, x).filter((t) => t.includes('_at_'));
		expect(at(crafted).sort()).toEqual(['makes_item_iron_gear_wheel_at_epic', 'uses_entity_assembling_machine_3_at_rare']);
		expect(at(a).sort()).toEqual([
			'module_speed_module_3_at_legendary',
			'uses_entity_assembling_machine_3_at_rare',
			'uses_entity_crusher_at_uncommon'
		]);
	});

	test('in an oversized print, module and quality tokens come before the long lists, so the cap keeps them', () => {
		const modded = Array.from({ length: 3000 }, (_, i) => ({ name: `some-mod-entity-with-a-long-name-${i}` }));
		const big = analyzePrint(
			blueprint([
				...modded,
				{ name: 'assembling-machine-3', quality: 'rare', recipe: 'iron-gear-wheel', items: [modules('speed-module-3', 'legendary', 4)] }
			])
		);
		const kept = facetText(facetTokens({ tags: [] }, big)).split(' ');
		expect(kept.length).toBeLessThan(facetTokens({ tags: [] }, big).length);
		expect(kept).toContain('module_speed_module_3');
		expect(kept).toContain('module_speed_module_3_at_legendary');
		expect(kept).toContain('quality_legendary');
		expect(kept).toContain('uses_entity_assembling_machine_3_at_rare');
		expect(kept).not.toContain('uses_entity_some_mod_entity_with_a_long_name_2999');
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

describe('2.1 renames', () => {
	const foundry = (version: number) => analyzePrint(blueprint([{ name: 'foundry', recipe: 'molten-iron' }], [], version)).nodes[0];

	test("a 2.0 foundry on molten-iron crafts 2.1's iron-ore-melting, with its rates", () => {
		const n = foundry(V2_0_77);
		expect(n.recipes).toEqual({ 'iron-ore-melting': 1 });
		expect(n.products).toEqual(['fluid:molten-iron']);
		expect(n.rates['fluid:molten-iron']).toBeGreaterThan(0);
	});

	test('a page saved in 2.1 keeps its names', () => {
		expect(foundry(2 * 2 ** 48 + 2 ** 32 + 23 * 2 ** 16).recipes).toEqual({ 'molten-iron': 1 });
	});
});

describe('unknown names', () => {
	const V2_1_23 = 2 * 2 ** 48 + 2 ** 32 + 23 * 2 ** 16;
	const V2_2_0 = 2 * 2 ** 48 + 2 * 2 ** 32;
	const modded = (version: number) => blueprint([{ name: 'some-unheard-of-machine' }], [], version);

	test('mean a mod from 2.0 up to the game data version, not before or after', () => {
		expect(analyzePrint(modded(V2_0_77)).mods).toEqual(['unknown-mod']);
		expect(analyzePrint(modded(V2_1_23)).mods).toEqual(['unknown-mod']);
		expect(analyzePrint(modded(V1_1_0)).mods).toEqual([]);
		const newer = analyzePrint(modded(V2_2_0));
		expect(newer.mods).toEqual([]);
		expect(newer.limits.some((l) => l.includes('version changes'))).toBe(true);
	});

	test("count by the version of the page that uses them, not the book's", () => {
		const book = (root: number, page: number) =>
			analyzePrint({ blueprint_book: { version: root, blueprints: [{ index: 0, ...modded(page) }] } });
		expect(book(V2_1_23, V1_1_0).mods).toEqual([]);
		expect(book(V1_1_0, V2_0_77).mods).toEqual(['unknown-mod']);
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

describe('parseRate', () => {
	// Rates are stored in items per second, whatever unit the label uses.
	test('per second labels', () => {
		expect(parseRate('Red science 10/s')).toBe(10);
		expect(parseRate('1.5 items/s')).toBe(1.5);
		expect(parseRate('Gears 2,5/sec')).toBe(2.5);
		expect(parseRate('7.5 / second')).toBe(7.5);
	});

	test('per minute labels are divided by 60', () => {
		expect(parseRate('Military science 45/min')).toBe(0.75);
		expect(parseRate('3 / minute')).toBe(0.05);
		expect(parseRate('90/m')).toBe(1.5);
		expect(parseRate('1 item/min')).toBeCloseTo(1 / 60);
	});

	test('forms it does not read yet', () => {
		expect(parseRate('45 SPM')).toBeNull();
		expect(parseRate('45 per minute')).toBeNull();
		expect(parseRate('1k spm base')).toBeNull();
		expect(parseRate('Smelting')).toBeNull();
		expect(parseRate(null)).toBeNull();
	});
});
