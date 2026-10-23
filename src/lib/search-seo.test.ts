import { describe, expect, test } from 'bun:test';
import { landingMeta, landingPath, searchPage, searchRel } from './search-seo.js';

const page = (query: string) => searchPage(new URLSearchParams(query));

describe('searchPage', () => {
	test('no search text or filter is the home page, whatever else is in the URL', () => {
		expect(page('')).toEqual({ kind: 'home' });
		expect(page('utm_source=reddit&fbclid=x')).toEqual({ kind: 'home' });
		expect(page('sort=favorites&q=')).toEqual({ kind: 'home' });
		expect(page('p=1')).toEqual({ kind: 'home' });
	});

	test('one makes or uses value is a landing page', () => {
		expect(page('makes=item:electronic-circuit')).toEqual({ kind: 'landing', key: 'makes', value: 'item:electronic-circuit' });
		expect(page('uses=foundry&utm_source=x')).toEqual({ kind: 'landing', key: 'uses', value: 'entity:foundry' });
		expect(page('makes=item:rail&makes=item:rail&sort=favorites')).toEqual({ kind: 'landing', key: 'makes', value: 'item:rail' });
	});

	test('anything more is neither', () => {
		for (const q of [
			'q=red',
			'makes=item:rail&makes=item:pipe',
			'makes=item:rail&sort=recent',
			'makes=item:rail&render=1',
			'version=2.0',
			'spaceAge=yes',
			'tag=/x/',
			'p=2',
			'makes=item:rail&p=2'
		])
			expect(page(q)).toBeNull();
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
