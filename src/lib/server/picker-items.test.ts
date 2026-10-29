import { describe, expect, mock, test } from 'bun:test';

// The picker's icon code reads the sprite bucket's settings; nothing here draws an icon.
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('$app/env', () => ({ dev: false }));
const { landingLinks } = await import('./picker-items.js');

describe('landingLinks', () => {
	test('links what a print makes and its buildings to their landing pages, and nothing else', () => {
		const links = landingLinks({
			outputs: ['item:rocket-fuel', 'fluid:water', 'item:some-modded-thing', 'item:rocket-fuel', 'entity:foundry', 'item:cargo-wagon'],
			// The cargo wagon is only a page's icon: nothing crafts it.
			products: ['item:rocket-fuel', 'fluid:water', 'item:some-modded-thing'],
			entities: { 'transport-belt': 400, inserter: 120, beacon: 12, foundry: 30, 'modded-machine': 500 }
		});
		expect(links.makes).toEqual([
			{ signal: 'item:rocket-fuel', label: 'Rocket fuel', href: '/?makes=item%3Arocket-fuel' },
			{ signal: 'fluid:water', label: 'Water', href: '/?makes=fluid%3Awater' }
		]);
		// Buildings only (belts and inserters have no landing page), most placed first.
		expect(links.uses).toEqual([
			{ signal: 'entity:foundry', label: 'Foundry', href: '/?uses=entity%3Afoundry' },
			{ signal: 'entity:beacon', label: 'Beacon', href: '/?uses=entity%3Abeacon' }
		]);
	});

	test('puts the ranked products first, and skips ranked ones the print has no token for', () => {
		const outputs = ['fluid:crude-oil', 'item:automation-science-pack', 'item:iron-gear-wheel'];
		const links = landingLinks({ outputs, products: outputs, entities: {} }, [
			'item:automation-science-pack',
			'item:iron-chest',
			'item:iron-gear-wheel'
		]);
		expect(links.makes.map((l) => l.signal)).toEqual(['item:automation-science-pack', 'item:iron-gear-wheel', 'fluid:crude-oil']);
	});

	test('keeps the first six', () => {
		const outputs = [
			'iron-gear-wheel',
			'copper-cable',
			'electronic-circuit',
			'advanced-circuit',
			'processing-unit',
			'engine-unit',
			'pipe',
			'iron-chest',
			'stone-furnace'
		].map((i) => `item:${i}`);
		expect(landingLinks({ outputs, products: outputs, entities: {} }).makes.map((l) => l.signal)).toEqual(outputs.slice(0, 6));
	});
});
