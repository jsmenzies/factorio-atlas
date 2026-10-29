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
			products: outputs.flat(),
			gameVersion: '2.0.72',
			requiresSpaceAge: false,
			...extra
		}) as unknown as PrintAnalysis;

	test('a book: what it is, then its pages and what they make', () => {
		expect(
			metaDescription(print([['item:electronic-circuit'], ['item:advanced-circuit']]), 'Nilaus', {
				makes: ['item:advanced-circuit', 'item:electronic-circuit']
			})
		).toBe('Factorio 2.0 blueprint book by Nilaus: 2 pages making advanced circuit and electronic circuit.');
	});

	test('science packs are counted together, and it says when there is a render', () => {
		const science = ['automation', 'logistic', 'military', 'chemical', 'production', 'utility'].map((s) => `item:${s}-science-pack`);
		const makes = [...science, 'item:transport-belt', 'item:electronic-circuit'];
		const a = print(
			Array.from({ length: 45 }, () => []),
			{ gameVersion: '0.16.51', products: makes }
		);
		expect(metaDescription(a, 'knoted', { makes, rendered: true })).toBe(
			'Factorio 0.16 blueprint book by knoted: 45 pages making 6 science packs, transport belt and electronic circuit. With a zoomable in-game render.'
		);
	});

	test('a book that crafts nothing: what its pages are, most first; page icons are not products', () => {
		const a = print(
			Array.from({ length: 137 }, () => []),
			{ roles: { belts: 26, rail: 95, fluids: 9, circuits: 5, bots: 2 } }
		);
		// A train station's icons name a cargo wagon, but nothing in the book crafts one.
		expect(metaDescription(a, 'Brian White', { makes: ['item:cargo-wagon', 'item:rail'] })).toBe(
			'Factorio 2.0 blueprint book by Brian White: 137 pages of rail, belts, fluids and circuits.'
		);
	});

	test('Space Age, and no author or version when unknown', () => {
		expect(metaDescription(print([[], []], { requiresSpaceAge: true }), ' ')).toBe(
			'Factorio 2.0 Space Age blueprint book: 2 pages of production.'
		);
		expect(metaDescription(print([[], []], { gameVersion: null, roles: {} }), null)).toBe('Factorio blueprint book: 2 pages.');
	});

	test('too long, it names fewer things rather than cutting a word', () => {
		const makes = [
			'item:power-armor-mk2',
			'item:personal-roboport-mk2-equipment',
			'item:fusion-reactor-equipment',
			'item:energy-shield-mk2-equipment'
		];
		const text = metaDescription(print([[], []], { products: makes }), 'An author with a rather long name indeed', {
			makes,
			rendered: true
		});
		expect(text.length).toBeLessThan(161);
		expect(text).not.toContain('…');
		expect(text).toBe(
			'Factorio 2.0 blueprint book by An author with a rather long name indeed: 2 pages making power armor mk2. With a zoomable in-game render.'
		);
	});

	test('a single blueprint: its summary, then what it is', () => {
		const a = print([['item:electronic-circuit']]);
		const node = { ...a.nodes[0], trainStops: [], wires: 0, signs: [], estimatedRate: 2.5 } as unknown as NodeAnalysis;
		expect(metaDescription({ ...a, nodes: [node] }, 'Nilaus', { rendered: true })).toBe(
			'Makes Electronic circuit ≈ 2.5/s. Factorio 2.0 blueprint by Nilaus. With a zoomable in-game render.'
		);
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
