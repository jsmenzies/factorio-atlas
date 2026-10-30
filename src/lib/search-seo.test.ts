import { describe, expect, test } from 'bun:test';
import { defaultSort, isFiltered, landingMeta, landingPath, searchPage, searchRel } from './search-seo.js';

const page = (query: string) => searchPage(new URLSearchParams(query));

describe('searchPage', () => {
	test('no search text or filter is the home page, whatever else is in the URL', () => {
		expect(page('')).toEqual({ kind: 'home' });
		expect(page('utm_source=reddit&fbclid=x')).toEqual({ kind: 'home' });
		// Newest first is the home page's own order; most favourited is another order of it.
		expect(page('sort=recent&q=')).toEqual({ kind: 'home' });
		expect(page('sort=favorites')).toBeNull();
		expect(page('p=1')).toEqual({ kind: 'home' });
	});

	test('one makes or uses value is a landing page', () => {
		expect(page('makes=item:electronic-circuit')).toEqual({ kind: 'landing', key: 'makes', value: 'item:electronic-circuit' });
		expect(page('uses=foundry&utm_source=x')).toEqual({ kind: 'landing', key: 'uses', value: 'entity:foundry' });
		expect(page('makes=item:rail&makes=item:rail&sort=favorites')).toEqual({ kind: 'landing', key: 'makes', value: 'item:rail' });
	});

	test('anything more is neither', () => {
		// An item at a quality, or the quality filter.
		expect(page('uses=entity:beacon@legendary')).toBeNull();
		expect(page('makes=item:processing-unit@rare')).toBeNull();
		expect(page('quality=legendary')).toBeNull();
		for (const q of [
			'q=red',
			'makes=item:rail&makes=item:pipe',
			'makes=item:rail&sort=recent',
			'makes=item:rail&render=1',
			'version=2.0',
			'spaceAge=yes',
			'tag=/x/',
			'author=h5YXq2',
			'p=2',
			'makes=item:rail&p=2'
		])
			expect(page(q)).toBeNull();
	});
});

describe('defaultSort', () => {
	const sortOf = (query: string) => defaultSort(new URLSearchParams(query));
	test('newest first on the home page, most favourited with any filter, best match with text', () => {
		for (const q of ['', 'p=3', 'utm_source=x', 'q=%20', 'sort=favorites', 'circuits=0', 'spaceAge=maybe', 'quality=shiny', 'makes='])
			expect(sortOf(q)).toBe('recent');
		for (const q of [
			'makes=item:rail',
			'uses=entity:foundry',
			'author=h5YXq2',
			'version=2.0',
			'tag=/x/',
			'quality=epic',
			'spaceAge=no',
			'circuits=1',
			'trains=1',
			'render=1',
			'module=speed-module-3'
		])
			expect(sortOf(q)).toBe('favorites');
		expect(sortOf('q=red')).toBe('relevance');
		expect(sortOf('q=red&makes=item:rail')).toBe('relevance');
		expect(isFiltered(new URLSearchParams('render=1'))).toBe(true);
		expect(isFiltered(new URLSearchParams('sort=recent&p=2'))).toBe(false);
	});
});

describe('links and meta', () => {
	test('nofollow only for links to pages that are noindex', () => {
		expect(searchRel('/')).toBeUndefined();
		expect(searchRel('/?makes=item%3Arail')).toBeUndefined();
		expect(searchRel('/?makes=item%3Arail&makes=item%3Apipe')).toBe('nofollow');
		expect(searchRel('/?version=2.0')).toBe('nofollow');
		expect(searchRel('/?makes=item%3Arail&p=1')).toBeUndefined();
		expect(searchRel('/?makes=item%3Arail&p=3')).toBe('nofollow');
		// A landing page in its own order (most favourited) is the landing page; newest first is another order.
		expect(searchRel('/?makes=item%3Arail&sort=favorites')).toBeUndefined();
		expect(searchRel('/?makes=item%3Arail&sort=recent')).toBe('nofollow');
		expect(searchRel('/?sort=favorites')).toBe('nofollow');
		expect(searchRel('/?sort=recent')).toBeUndefined();
		expect(searchRel('/?sort=popular')).toBe('nofollow');
	});

	test('a landing page has one URL', () => {
		expect(landingPath({ key: 'makes', value: 'item:electronic-circuit' })).toBe('/?makes=item%3Aelectronic-circuit');
	});

	test('titles and descriptions', () => {
		expect(landingMeta({ key: 'makes', value: 'item:electronic-circuit' }, 'Electronic circuit', 142)).toEqual({
			title: 'Electronic circuit blueprints for Factorio · Blueprint Atlas',
			description:
				'142 Factorio blueprints that make Electronic circuit, decoded and analysed: rates, game version, Space Age. Sorted by favourites.'
		});
		expect(landingMeta({ key: 'uses', value: 'entity:foundry' }, 'Foundry', 1).description).toBe(
			'1 Factorio blueprint built with Foundry, decoded and analysed: rates, game version, Space Age. Sorted by favourites.'
		);
		expect(
			landingMeta({ key: 'makes', value: 'item:rail' }, 'Rail', 1).description.startsWith('1 Factorio blueprint that makes Rail,')
		).toBe(true);
	});
});
