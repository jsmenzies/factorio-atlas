import { describe, expect, test } from 'bun:test';
import { bookProducts, describeBook, metaDescription } from './describe.js';
import type { NodeAnalysis, PrintAnalysis } from './server/pipeline/analyze.js';

const page = (path: string, label: string, outputs: string[], inputs: string[] = [], extra: Partial<NodeAnalysis> = {}) =>
	({
		path,
		kind: 'blueprint',
		label,
		icons: [],
		outputs,
		inputs,
		products: outputs,
		rates: {},
		claimedRate: null,
		estimatedRate: null,
		role: 'production',
		...extra
	}) as unknown as NodeAnalysis;

const section = (s: string) =>
	s.endsWith('-science-pack') ? 'Science' : s.startsWith('fluid:') ? 'Fluids' : /machine|drill/.test(s) ? 'Production' : 'Intermediates';

describe('bookProducts', () => {
	const pages = [
		page('0', '1. Gears & Belts', ['item:iron-gear-wheel', 'item:transport-belt'], ['item:iron-plate'], {
			rates: { 'item:iron-gear-wheel': 1 }
		}),
		page('1', '2. Red Science', ['item:automation-science-pack'], ['item:iron-gear-wheel', 'item:copper-plate'], { claimedRate: 1.5 }),
		page('2', '2. Red Science (Gear-input)', ['item:automation-science-pack'], ['item:iron-gear-wheel'], { claimedRate: 1.5 }),
		page('3', '3. Oil', ['fluid:petroleum-gas'], ['fluid:crude-oil']),
		page('4', '4. Production Shop', ['item:pumpjack'], ['item:steel-plate'], {
			products: ['item:pumpjack', 'item:pipe', 'item:assembling-machine-2', 'item:electric-mining-drill']
		})
	];
	const { main, groups } = bookProducts(pages, section);

	test('main products: science first, nothing another page uses, no fluids, no mall items', () => {
		expect(main.map((m) => m.signal)).toEqual(['item:automation-science-pack', 'item:transport-belt']);
	});

	test('variants share one entry with the best rate and every page', () => {
		expect(main[0]).toEqual({ signal: 'item:automation-science-pack', rate: 1.5, claimed: true, pages: ['1', '2'] });
	});

	test('the rest is grouped: intermediates, mall and shop products, fluids', () => {
		expect(groups.map((g) => [g.name, g.items.map((m) => m.signal)])).toEqual([
			['Intermediates', ['item:iron-gear-wheel']],
			['Mall & shops', ['item:pumpjack', 'item:pipe', 'item:assembling-machine-2', 'item:electric-mining-drill']],
			['Fluids', ['fluid:petroleum-gas']]
		]);
	});

	test('a print that only makes fluids still leads with them', () => {
		expect(bookProducts([page('', 'Oil', ['fluid:petroleum-gas'])], section).main.map((m) => m.signal)).toEqual(['fluid:petroleum-gas']);
	});
});

describe('describeBook', () => {
	const book = (labels: string[], roles: Record<string, number>) =>
		({ nodes: labels.map((l, i) => page(String(i), l, [])), roles }) as unknown as PrintAnalysis;

	test('numbered labels become build stages', () => {
		expect(describeBook(book(['1. Gears', '1. Bricks', '2. Steam Power', '3. Labs'], { production: 3, power: 1 }))).toBe(
			'4 pages in 3 build stages, from “Gears” to “Labs”. 3 production, 1 power.'
		);
	});

	test('unnumbered books get a page count and the role mix', () => {
		expect(describeBook(book(['1 to 1', '1 to 2', '2 to 1'], { belts: 3 }))).toBe('Book of 3 pages. All belt pages.');
	});
});

describe('metaDescription', () => {
	const print = (outputs: string[][], extra: Partial<PrintAnalysis> = {}) =>
		({
			nodes: outputs.map((o, i) => page(String(i), `Page ${i}`, o)),
			roles: { production: outputs.length },
			gameVersion: '2.0.72',
			requiresSpaceAge: false,
			...extra
		}) as unknown as PrintAnalysis;

	test('the summary, then version, book and author', () => {
		expect(metaDescription(print([['item:electronic-circuit'], ['item:advanced-circuit']]), 'Nilaus')).toBe(
			'Book of 2 pages. Makes Advanced circuit, Electronic circuit. Factorio 2.0 blueprint book by Nilaus.'
		);
	});

	test('Space Age, and no author or version when unknown', () => {
		expect(metaDescription(print([[], []], { requiresSpaceAge: true }), ' ')).toBe(
			'Book of 2 pages. Factorio 2.0 Space Age blueprint book.'
		);
		expect(metaDescription(print([[], []], { gameVersion: null }), null)).toBe('Book of 2 pages. Factorio blueprint book.');
	});

	test('a long summary is cut at a word; the last sentence stays whole', () => {
		const many = Array.from({ length: 40 }, (_, i) => [`item:product-number-${i}`]);
		const text = metaDescription(print(many, { roles: { production: 30, belts: 5, rail: 5 } }), 'An author with a long name');
		expect(text.length).toBeLessThan(161);
		expect(text.endsWith('… Factorio 2.0 blueprint book by An author with a long name.')).toBe(true);
		expect(text.startsWith('Book of 40 pages: 30 production · 5 belts · 5 rail.')).toBe(true);
	});

	test('a book page: its own summary and where it sits in the book', () => {
		const a = print([['item:electronic-circuit'], ['item:advanced-circuit'], []]);
		const node = { ...a.nodes[1], trainStops: [], wires: 0, signs: [], estimatedRate: 2.5 } as unknown as NodeAnalysis;
		expect(metaDescription(a, 'Nilaus', { page: { node, index: 1 } })).toBe(
			'Makes Advanced circuit ≈ 2.5/s. Page 2 of 3 in a Factorio 2.0 blueprint book by Nilaus.'
		);
		expect(metaDescription(a, 'Nilaus', { page: { node, index: 1 }, rendered: true })).toBe(
			'Makes Advanced circuit ≈ 2.5/s. Page 2 of 3 in a Factorio 2.0 blueprint book by Nilaus. With a zoomable in-game render.'
		);
	});
});
