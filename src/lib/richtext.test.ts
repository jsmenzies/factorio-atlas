import { describe, expect, test } from 'bun:test';
import { parseRichText, plainText, richTextIcons } from './richtext.js';

describe('parseRichText', () => {
	test('turns item tags into sprite icons', () => {
		expect(parseRichText('Big Boy Space Science[item=space-science-pack]')).toEqual([
			{ kind: 'text', text: 'Big Boy Space Science' },
			{ kind: 'icon', type: 'item', name: 'space-science-pack', sprite: 'item' }
		]);
	});

	test('reads quality suffixes and img paths', () => {
		expect(parseRichText('[item=iron-plate,quality=rare]')).toEqual([{ kind: 'icon', type: 'item', name: 'iron-plate', sprite: 'item' }]);
		expect(parseRichText('[img=fluid/water]')).toEqual([{ kind: 'icon', type: 'fluid', name: 'water', sprite: 'item' }]);
		expect(parseRichText('[planet=vulcanus]')).toEqual([{ kind: 'icon', type: 'planet', name: 'vulcanus', sprite: null }]);
	});

	test('names icons in plain text, spaced from the words around them', () => {
		expect(plainText('Big Boy Space Science[item=space-science-pack]')).toBe('Big Boy Space Science Space science pack');
	});

	test('drops colour and font tags but keeps their text', () => {
		expect(plainText('[color=red]Hot[/color] [font=default-bold]stuff[/font]')).toBe('Hot stuff');
	});

	test('leaves square brackets that are not rich text alone', () => {
		expect(plainText('[WIP] Mall [v2]')).toBe('[WIP] Mall [v2]');
	});
});

test('richTextIcons collects sprite names by kind', () => {
	expect(richTextIcons(['A [item=gear] [entity=beacon] [recipe=x]', null, 'plain'])).toEqual({
		item: ['gear'],
		entity: ['beacon'],
		recipe: ['x']
	});
});
