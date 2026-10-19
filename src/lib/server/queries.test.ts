import { describe, expect, test } from 'bun:test';
import { facetText } from './pipeline/repository.js';
import { parseSearch } from './queries.js';

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
		expect(usesOf('?uses=entity:foundry')).toBe('entity:foundry');
		expect(usesOf('?uses=biolab')).toBe('entity:biolab');
		expect(usesOf('?uses=')).toBe(null);
		expect(usesOf('')).toBe(null);
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
