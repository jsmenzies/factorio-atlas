import { describe, expect, test } from 'bun:test';
import { facetText, RENDER_TOKEN } from './pipeline/repository.js';
import { clipQuery, filterTokens, MAX_FILTER_VALUES, MAX_PAGES, MAX_QUERY_LENGTH, parsePage, parseSearch } from './queries.js';

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

describe('parseSearch page', () => {
	test('?p= is a whole page number from 1 to MAX_PAGES', () => {
		expect(parsePage(null)).toBe(1);
		expect(parsePage('3')).toBe(3);
		expect(parsePage('0')).toBe(1);
		expect(parsePage('-2')).toBe(1);
		expect(parsePage('2.5')).toBe(1);
		expect(parsePage('two')).toBe(1);
		expect(parsePage('999')).toBe(MAX_PAGES);
		expect(parseSearch(new URL('http://x/?q=belt&p=4')).page).toBe(4);
		expect(parseSearch(new URL('http://x/')).page).toBe(1);
	});
});

describe('search caps', () => {
	test('long text is cut at a word, short text is kept', () => {
		const words = 'electronic circuits '.repeat(20).trim();
		const clipped = clipQuery(words);
		expect(clipped.length).toBeLessThan(MAX_QUERY_LENGTH + 1);
		expect(words.startsWith(clipped)).toBe(true);
		expect(clipped.endsWith('circuits') || clipped.endsWith('electronic')).toBe(true);
		expect(clipQuery('red science')).toBe('red science');
		expect(clipQuery('x'.repeat(300))).toBe('x'.repeat(MAX_QUERY_LENGTH));
		expect(parseSearch(new URL(`http://x/?q=${encodeURIComponent(words)}`)).q).toBe(clipped);
	});
	test('a 172-character query fits', () => {
		const q =
			'nilaus base in a book red green blue science electronic circuits advanced circuits processing units space age tileable beaconed 2.0 belt balancer train station oil refinery';
		expect(clipQuery(q)).toBe(q);
	});
	test('a repeated filter keeps its first MAX_FILTER_VALUES values', () => {
		const url = new URL(`http://x/?${Array.from({ length: 15 }, (_, i) => `makes=item:x${i}`).join('&')}`);
		expect(parseSearch(url).makes).toEqual(Array.from({ length: MAX_FILTER_VALUES }, (_, i) => `item:x${i}`));
	});
});
