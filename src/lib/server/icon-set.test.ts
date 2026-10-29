import { describe, expect, mock, test } from 'bun:test';

// The icon code reads the sprite bucket's settings; nothing here draws an icon.
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('$app/env', () => ({ dev: false }));
const { resolveIcon } = await import('./icon-set.js');

describe('resolveIcon', () => {
	test("old names find their current name's icon", () => {
		expect(resolveIcon('recipe', 'wood-processing')).toBe('recipe/tree-seed');
		expect(resolveIcon('entity', 'cargo-bay-extractor')).toBe('entity/landing-pad-unloading-bay');
		expect(resolveIcon('item', 'science-pack-1')).toBe('item/automation-science-pack');
	});

	test('a name with an icon of its own keeps it', () => {
		expect(resolveIcon('recipe', 'iron-ore-melting')).toBe('recipe/iron-ore-melting');
		expect(resolveIcon('fluid', 'molten-iron')).toBe('fluid/molten-iron');
	});
});
