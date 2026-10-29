import { describe, expect, test } from 'bun:test';
import { DLC_MODS, gameData } from './game-data';

describe('renames', () => {
	test("2.1's renames reach names saved in 2.0, not 2.1", () => {
		expect(gameData.migrate('recipe', 'molten-iron', [2, 0])).toBe('iron-ore-melting');
		expect(gameData.migrate('recipe', 'wood-processing', [2, 0])).toBe('tree-seed');
		expect(gameData.migrate('entity', 'cargo-bay-extractor', [2, 0])).toBe('landing-pad-unloading-bay');
		expect(gameData.migrate('recipe', 'molten-iron', [2, 1])).toBe('molten-iron');
	});

	test('1.x names go through every step; 2.0 names skip the 1.x ones', () => {
		expect(gameData.migrate('item', 'science-pack-1', [0, 16])).toBe('automation-science-pack');
		expect(gameData.migrate('entity', 'stack-inserter', [1, 1])).toBe('bulk-inserter');
		expect(gameData.migrate('entity', 'stack-inserter', [2, 0])).toBe('stack-inserter');
	});
});

describe('2.1 data', () => {
	test('a recipe lists every category it can be made in', () => {
		expect(gameData.recipes['advanced-circuit'].categories).toEqual(['crafting', 'electromagnetics']);
		expect(gameData.recipes['iron-gear-wheel'].categories).toEqual(['crafting']);
	});

	test('chances count, shared or independent', () => {
		expect(Object.fromEntries(gameData.recipes['uranium-processing'].results)).toEqual({ 'uranium-235': 0.007, 'uranium-238': 0.993 });
		expect(Object.fromEntries(gameData.recipes['jellynut-processing'].results)['jellynut-seed']).toBe(0.02);
	});

	test('raw items only one planet has', () => {
		expect(gameData.planetResources.vulcanus).toEqual(['calcite', 'lava', 'tungsten-ore']);
		expect(gameData.planetResources.fulgora).toEqual(['scrap']);
	});

	test('the recycler is its own mod, and counts as DLC', () => {
		expect(gameData.modOf('recycler')).toBe('recycler');
		expect(gameData.modOf('landing-pad-unloading-bay')).toBe('space-age');
		expect(DLC_MODS.has('recycler')).toBe(true);
	});

	test('the unloading bay stands on 4×4 tiles, though its chute is in its collision box', () => {
		expect(gameData.entities['landing-pad-unloading-bay'].size).toEqual([4, 4]);
	});
});
