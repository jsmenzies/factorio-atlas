import { describe, expect, test } from 'bun:test';
import { facetText, RENDER_TOKEN } from './pipeline/repository.js';
import { filterTokens, parseSearch } from './queries.js';

const sortOf = (search: string) => parseSearch(new URL(`http://x/${search}`)).sort;

describe('parseSearch sort', () => {
	test('defaults to most favourited without text, best match with it', () => {
		expect(sortOf('')).toBe('favorites');
		expect(sortOf('?makes=item:pipe')).toBe('favorites');
		expect(sortOf('?q=smelting')).toBe('relevance');
		expect(sortOf('?q=%20%20')).toBe('favorites');
	});

	test('keeps an explicit sort', () => {
		expect(sortOf('?q=smelting&sort=favorites')).toBe('favorites');
		expect(sortOf('?q=smelting&sort=recent')).toBe('recent');
		expect(sortOf('?sort=recent')).toBe('recent');
	});

	test('best match without text, or an unknown sort, falls back to the default', () => {
		expect(sortOf('?sort=relevance')).toBe('favorites');
		expect(sortOf('?q=smelting&sort=bogus')).toBe('relevance');
		expect(sortOf('?sort=bogus')).toBe('favorites');
	});
});

describe('parseSearch uses', () => {
	const usesOf = (search: string) => parseSearch(new URL(`http://x/${search}`)).uses;

	test('takes an entity signal, or a bare entity name', () => {
		expect(usesOf('?uses=entity:foundry')).toEqual(['entity:foundry']);
		expect(usesOf('?uses=biolab')).toEqual(['entity:biolab']);
		expect(usesOf('?uses=')).toEqual([]);
		expect(usesOf('')).toEqual([]);
		expect(usesOf('?uses=foundry&uses=entity:foundry&uses=beacon')).toEqual(['entity:foundry', 'entity:beacon']);
	});
});

describe('parseSearch repeated filters', () => {
	const of = (search: string) => parseSearch(new URL(`http://x/${search}`));

	test('every value of a filter is kept once, in order, and each becomes a token', () => {
		const s = of('?makes=item:iron-plate&makes=item:copper-plate&makes=item:iron-plate&makes=&version=2.0&version=1.1');
		expect(s.makes).toEqual(['item:iron-plate', 'item:copper-plate']);
		expect(s.version).toEqual(['2.0', '1.1']);
		expect(filterTokens(s)).toEqual(['makes_item_iron_plate', 'makes_item_copper_plate', 'v_2_0', 'v_1_1']);
	});
});

describe('parseSearch render', () => {
	const of = (search: string) => parseSearch(new URL(`http://x/${search}`));

	test('?render=1 turns it on; anything else leaves it off', () => {
		expect(of('').render).toBe(false);
		expect(of('?render=1').render).toBe(true);
		expect(of('?render=0').render).toBe(false);
		expect(of('?render=yes').render).toBe(false);
	});

	test('works with text, sort and other filters', () => {
		const s = of('?q=smelting&render=1&spaceAge=no&sort=recent&makes=item:iron-plate');
		expect([s.q, s.render, s.spaceAge, s.sort, s.makes]).toEqual(['smelting', true, 'no', 'recent', ['item:iron-plate']]);
		expect(of('?render=1').sort).toBe('favorites');
		expect(filterTokens(of('?render=1&circuits=1'))).toEqual(['uses_circuits', RENDER_TOKEN]);
	});
});

describe('facetText', () => {
	test('keeps whole tokens under the FTS column cap', () => {
		const tokens = Array.from({ length: 2000 }, (_, i) => `recipe_some_long_recipe_name_${i}`);
		const text = facetText(tokens);
		expect(text.length <= 32 * 1024).toBe(true);
		expect(text.split(' ').every((t, i) => t === tokens[i])).toBe(true);
		expect(facetText(['a', 'b'])).toBe('a b');
	});
});
