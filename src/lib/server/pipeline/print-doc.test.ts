import { expect, test } from 'bun:test';
import { analyzePrint } from './analyze';
import { pageAnalysis } from './print-doc';

const V2_0_77 = 2 * 2 ** 48 + 77 * 2 ** 16;

test('pageAnalysis leaves out only the fields the print page never shows', () => {
	const a = analyzePrint({
		blueprint_book: {
			version: V2_0_77,
			blueprints: [
				{
					index: 0,
					blueprint: {
						version: V2_0_77,
						label: '[item=iron-plate] Plates',
						entities: [{ entity_number: 1, name: 'constant-combinator', position: { x: 0.5, y: 0.5 } }]
					}
				}
			]
		}
	});
	const page = pageAnalysis(a);
	const unshown = ['signItems', 'signals', 'richText', 'combinators', 'schedules', 'furnacesWithoutRecipe', 'qualities'];
	expect(a.nodes.length).toBe(2);
	expect('labels' in page).toBe(false);
	for (const [i, n] of page.nodes.entries()) {
		for (const k of unshown) expect(k in n).toBe(false);
		// Everything else is the analysis' own.
		const full: Record<string, unknown> = { ...a.nodes[i] };
		for (const k of unshown) delete full[k];
		expect(n).toEqual(full as typeof n);
	}
	const { labels: _labels, nodes: _nodes, ...printLevel } = a;
	const { nodes: _pageNodes, ...pagePrintLevel } = page;
	expect(pagePrintLevel).toEqual(printLevel);
	// The document itself is untouched.
	expect(a.nodes[1].signals).not.toBeUndefined();
	expect(a.labels).not.toBeUndefined();
});
