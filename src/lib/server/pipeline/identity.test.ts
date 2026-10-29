import { describe, expect, test } from 'bun:test';
import { fingerprintPrint } from './identity';

const V1 = 281479275151360; // 1.1.0.0
const V2 = 562949954076672; // 2.0.10.0

const page = (over: Record<string, unknown> = {}) => ({
	blueprint: {
		item: 'blueprint',
		label: 'Gears',
		version: V2,
		entities: [
			{ entity_number: 1, name: 'assembling-machine-2', position: { x: 10.5, y: 20.5 }, recipe: 'iron-gear-wheel' },
			{ entity_number: 2, name: 'inserter', position: { x: 12.5, y: 20.5 }, direction: 4 },
			{ entity_number: 3, name: 'small-electric-pole', position: { x: 12.5, y: 21.5 } },
			{ entity_number: 4, name: 'small-electric-pole', position: { x: 14.5, y: 21.5 } }
		],
		wires: [
			[1, 1, 2, 1],
			[3, 5, 4, 5]
		],
		...over
	}
});

const one = async (p: unknown) => (await fingerprintPrint(p)).pages[0];

describe('fingerprintPrint', () => {
	test('ignores entity order and numbers, position in the world, words and version', async () => {
		const a = await one(page());
		const shuffled = page({
			label: 'Something else',
			description: 'new words',
			icons: [{ signal: { name: 'inserter' }, index: 1 }],
			version: V2 + 65536,
			entities: [
				{ entity_number: 7, name: 'small-electric-pole', position: { x: 114.5, y: 1.5 } },
				{ entity_number: 9, name: 'inserter', position: { x: 112.5, y: 0.5 }, direction: 4 },
				{ entity_number: 8, name: 'small-electric-pole', position: { x: 112.5, y: 1.5 } },
				{ entity_number: 5, name: 'assembling-machine-2', position: { x: 110.5, y: 0.5 }, recipe: 'iron-gear-wheel' }
			],
			wires: [
				[8, 5, 7, 5],
				[9, 1, 5, 1]
			]
		});
		const b = await one(shuffled);
		expect(b.exact).toBe(a.exact);
		expect(b.layout).toBe(a.layout);
		expect(b.label).toBe('Something else');
	});

	test('a moved entity, a changed recipe or a cut wire is another print', async () => {
		const a = await one(page());
		const moved = page();
		(moved.blueprint.entities as { position: { x: number } }[])[1].position.x = 13.5;
		const recipe = page();
		(recipe.blueprint.entities as { recipe?: string }[])[0].recipe = 'copper-cable';
		const cut = page({ wires: [[3, 5, 4, 5]] });
		for (const p of [moved, recipe, cut]) {
			const b = await one(p);
			expect(b.exact).not.toBe(a.exact);
			expect(b.layout).not.toBe(a.layout);
		}
	});

	test('a setting changes exact but not layout', async () => {
		const a = await one(page());
		const b = page();
		(b.blueprint.entities as Record<string, unknown>[])[1].control_behavior = { circuit_enabled: true };
		const fb = await one(b);
		expect(fb.exact).not.toBe(a.exact);
		expect(fb.layout).toBe(a.layout);
	});

	test('1.x directions and wires match the same layout saved in 2.0', async () => {
		const a = await one(page());
		const old = page({
			version: V1,
			entities: [
				{
					entity_number: 1,
					name: 'assembling-machine-2',
					position: { x: 10.5, y: 20.5 },
					recipe: 'iron-gear-wheel',
					connections: { '1': { red: [{ entity_id: 2 }] } }
				},
				{
					entity_number: 2,
					name: 'inserter',
					position: { x: 12.5, y: 20.5 },
					direction: 2,
					connections: { '1': { red: [{ entity_id: 1 }] } }
				},
				{ entity_number: 3, name: 'small-electric-pole', position: { x: 12.5, y: 21.5 }, neighbours: [4] },
				{ entity_number: 4, name: 'small-electric-pole', position: { x: 14.5, y: 21.5 }, neighbours: [3] }
			],
			wires: undefined
		});
		const b = await one(old);
		expect(b.layout).toBe(a.layout);
		expect(b.exact).not.toBe(a.exact);
	});

	test('books: pages in order, the same set reordered, empty pages skipped', async () => {
		const p1 = page();
		const p2 = page({ entities: [{ entity_number: 1, name: 'stone-furnace', position: { x: 0, y: 0 } }], wires: [] });
		const book = (pages: unknown[]) => ({
			blueprint_book: { item: 'blueprint-book', blueprints: pages.map((p, index) => ({ ...(p as object), index })) }
		});
		const empty = { blueprint: { item: 'blueprint', label: 'notes' } };
		const a = await fingerprintPrint(book([p1, empty, p2]));
		const b = await fingerprintPrint(book([p2, p1]));
		expect(a.pages.map((p) => p.path)).toEqual(['0', '2']);
		expect(a.book?.exact).not.toBe(b.book?.exact);
		expect(a.book?.exactSet).toBe(b.book?.exactSet);
		expect(a.book?.layoutSet).toBe(b.book?.layoutSet);
		expect((await fingerprintPrint(p1)).book).toBeNull();
	});

	test('exact measures entities and tiles from one corner; layout from each its own', async () => {
		const tiles = (dx: number) =>
			[0, 1, 2].flatMap((x) => [0, 1].map((y) => ({ name: 'stone-path', position: { x: 9 + x + dx, y: 19 + y } })));
		const a = await one(page({ tiles: tiles(0) }));
		const shiftedOnFloor = await one(page({ tiles: tiles(1) }));
		expect(shiftedOnFloor.exact).not.toBe(a.exact);
		expect(shiftedOnFloor.layout).toBe(a.layout);
		// Moving both together is still the same print.
		const moved = page({ tiles: tiles(0).map((t) => ({ ...t, position: { x: t.position.x + 7, y: t.position.y } })) });
		for (const e of moved.blueprint.entities as { position: { x: number } }[]) e.position.x += 7;
		expect((await one(moved)).exact).toBe(a.exact);
	});

	test("book paths are the analysis's: a missing index counts as 0, so paths can repeat", async () => {
		const p2 = page({ entities: [{ entity_number: 1, name: 'stone-furnace', position: { x: 0, y: 0 } }], wires: [] });
		const fp = await fingerprintPrint({ blueprint_book: { item: 'blueprint-book', blueprints: [page(), p2] } });
		expect(fp.pages.map((p) => p.path)).toEqual(['0', '0']);
		expect(fp.pages[0].exact).not.toBe(fp.pages[1].exact);
	});

	test('whole print: one page is the same print alone or in a book; several pages in their order', async () => {
		const p2 = page({ entities: [{ entity_number: 1, name: 'stone-furnace', position: { x: 0, y: 0 } }], wires: [] });
		const book = (pages: unknown[]) => ({
			blueprint_book: { item: 'blueprint-book', blueprints: pages.map((p, index) => ({ ...(p as object), index })) }
		});
		const lone = await fingerprintPrint(page());
		const inBook = await fingerprintPrint(book([page()]));
		expect(inBook.whole).toEqual(lone.whole);
		expect(lone.whole?.size).toBe(4);
		const ab = await fingerprintPrint(book([page(), p2]));
		const ba = await fingerprintPrint(book([p2, page()]));
		expect(ab.whole?.exact).not.toBe(ba.whole?.exact);
		expect(ab.book?.exactSet).toBe(ba.book?.exactSet);
		expect(ab.whole?.exact).not.toBe(lone.whole?.exact);
		expect(ab.whole?.size).toBe(5);
		expect((await fingerprintPrint({ blueprint: { item: 'blueprint' } })).whole).toBeNull();
	});
});
