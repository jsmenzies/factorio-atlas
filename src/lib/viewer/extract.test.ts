import { describe, expect, test } from 'bun:test';
import { gameCatalog } from './catalog.server';
import { extractPage } from './extract';

const V2_0_77 = 2 * 2 ** 48 + 77 * 2 ** 16;
const V2_1_23 = 2 * 2 ** 48 + 2 ** 32 + 23 * 2 ** 16;
const catalog = gameCatalog();

describe('extractPage with the game data', () => {
	test("a 2.0 foundry on molten-iron (2.1's iron-ore-melting) uses fluid; a 2.1 one on a name 2.1 lacks doesn't", () => {
		const page = (version: number) =>
			extractPage(
				{ blueprint: { version, entities: [{ entity_number: 1, name: 'foundry', position: { x: 0.5, y: 0.5 }, recipe: 'molten-iron' }] } },
				'',
				catalog
			);
		expect(page(V2_0_77)?.entities[0][4]?.fluid).toBe(1);
		expect(page(V2_1_23)?.entities[0][4]?.fluid).toBeUndefined();
	});

	test('unloading bays on whole tiles beside a landing pad shift nothing', () => {
		const bays = [0, 1, 2, 3].map((i) => ({
			entity_number: 2 + i,
			name: 'landing-pad-unloading-bay',
			position: { x: 6, y: -6 + 4 * i },
			direction: 4
		}));
		const page = extractPage(
			{ blueprint: { version: V2_1_23, entities: [{ entity_number: 1, name: 'cargo-landing-pad', position: { x: 0, y: 0 } }, ...bays] } },
			'',
			catalog
		);
		expect(page?.offset).toBeUndefined();
		expect(page?.entities.map(([, x, y]) => [x, y])).toEqual([[0, 0], ...bays.map((b) => [b.position.x, b.position.y])]);
	});
});
