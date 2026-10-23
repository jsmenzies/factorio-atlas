import { describe, expect, test } from 'bun:test';
import { groupPages, uniqueTails } from './book-groups.js';
import type { PageRef } from './viewer/types.js';

const node = (path: string, kind: PageRef['kind'] = 'blueprint', label: string | null = null): PageRef => ({
	path,
	kind,
	label,
	depth: path.split('/').length,
	entities: 1
});

describe('groupPages', () => {
	test('stages from leading numbers, titles without them, runs in book order', () => {
		const titles: Record<string, string> = {
			'0': '1. Gears & Yellow Belts',
			'1': '1. Red Science',
			'2': '2. Steam Power',
			'3': '3) Basic Smelting',
			'4': 'Jump Start Base'
		};
		const groups = groupPages(
			Object.keys(titles).map((p) => node(p)),
			(p) => titles[p]
		);
		expect(groups.map((g) => [g.title, g.stage, g.pages.map((p) => `${p.n} ${p.title}`)])).toEqual([
			['Stage 1', 1, ['1 Gears & Yellow Belts', '2 Red Science']],
			['Stage 2', 2, ['3 Steam Power']],
			['Stage 3', 3, ['4 Basic Smelting']],
			['Other pages', null, ['5 Jump Start Base']]
		]);
	});

	test('one number for every page is not a stage list', () => {
		const groups = groupPages([node('0'), node('1')], () => '1. Same');
		expect(groups.map((g) => [g.title, g.pages.map((p) => p.title)])).toEqual([[null, ['1. Same', '1. Same']]]);
	});

	test('sub-books when the names have no numbers; book nodes are not pages', () => {
		const titles: Record<string, string> = {
			'0': 'Smelting',
			'0/0': 'Iron',
			'0/1': 'Copper',
			'1': 'Mall',
			'1/0': 'Belts',
			'2': 'Loose page'
		};
		const nodes = [node('0', 'blueprint_book'), node('0/0'), node('0/1'), node('1', 'blueprint_book'), node('1/0'), node('2')];
		const groups = groupPages(nodes, (p) => titles[p]);
		expect(groups.map((g) => [g.title, g.pages.map((p) => p.n)])).toEqual([
			['Smelting', [1, 2]],
			['Mall', [3]],
			['Pages', [4]]
		]);
	});

	test('nested sub-books are named by their shortest unique chain', () => {
		const titles: Record<string, string> = {
			'0': 'Rails',
			'0/0': 'Intersections',
			'1': 'Trains',
			'1/0': 'Intersections',
			'1/1': 'Stations'
		};
		const nodes = ['0', '0/0', '1', '1/0', '1/1'].map((p) => node(p, 'blueprint_book'));
		const pages = ['0/0/0', '0/0/1', '1/0/0', '1/1/0'].map((p) => node(p));
		const groups = groupPages([...nodes, ...pages], (p) => titles[p] ?? `Page ${p}`);
		expect(groups.map((g) => [g.title, g.pages.length])).toEqual([
			['Rails › Intersections', 2],
			['Trains › Intersections', 1],
			['Stations', 1]
		]);
	});

	test('uniqueTails numbers chains alike at full length', () => {
		expect(uniqueTails([['A', 'X'], ['B', 'X'], ['Y'], ['Y']])).toEqual([
			{ depth: 2, number: null },
			{ depth: 2, number: null },
			{ depth: 1, number: 1 },
			{ depth: 1, number: 2 }
		]);
	});

	test('a flat book is one untitled group; no pages, no groups', () => {
		expect(groupPages([node('0'), node('1')], (p) => `Page ${p}`).map((g) => g.title)).toEqual([null]);
		expect(groupPages([node('0', 'upgrade_planner')], () => 'x')).toEqual([]);
	});
});
