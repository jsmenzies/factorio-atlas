import { describe, expect, test } from 'bun:test';
import {
	gridMove,
	gridRows,
	initialTab,
	landOn,
	pickParam,
	printCount,
	score,
	sectionHeading,
	tabStep,
	TABS,
	type PickerItem
} from './picker.js';

const item = (name: string, sort: string, extra: Partial<PickerItem> = {}): PickerItem => ({
	signal: `item:${name}`,
	name,
	label: name,
	section: 'Logistics',
	sort,
	nicknames: [],
	n: 0,
	...extra
});

describe('gridRows', () => {
	test('sorts by game order and starts a row per subgroup', () => {
		const rows = gridRows([item('c', 'a|b|a'), item('b', 'a|a|b'), item('a', 'a|a|a')]);
		expect(rows.map((r) => r.map((i) => i.name))).toEqual([['a', 'b'], ['c']]);
	});

	test('compares order strings as plain strings, as the game does', () => {
		// "[" sorts after upper-case letters but before lower-case ones in code-unit order.
		const rows = gridRows([item('x', 'a|a|a[x]'), item('y', 'a|a|aZ')]);
		expect(rows[0].map((i) => i.name)).toEqual(['y', 'x']);
	});

	test('wraps long subgroups at the column count', () => {
		const items = Array.from({ length: 7 }, (_, i) => item(`i${i}`, `a|a|${i}`));
		expect(gridRows(items, 3).map((r) => r.length)).toEqual([3, 3, 1]);
	});
});

describe('gridMove', () => {
	const rows = [3, 1, 2];

	test('arrows step within the grid, clamping the column to shorter rows', () => {
		expect(gridMove(rows, { row: 0, col: 1 }, 'ArrowRight')).toEqual({ row: 0, col: 2 });
		expect(gridMove(rows, { row: 0, col: 2 }, 'ArrowDown')).toEqual({ row: 1, col: 0 });
		expect(gridMove(rows, { row: 1, col: 0 }, 'ArrowDown')).toEqual({ row: 2, col: 0 });
		expect(gridMove(rows, { row: 2, col: 1 }, 'ArrowUp')).toEqual({ row: 1, col: 0 });
	});

	test('Down on the last row stays put; Up on the first leaves the grid', () => {
		expect(gridMove(rows, { row: 2, col: 1 }, 'ArrowDown')).toEqual({ row: 2, col: 1 });
		expect(gridMove(rows, { row: 0, col: 2 }, 'ArrowUp')).toEqual({ leave: 'up' });
	});

	test('Left/Right past a row edge switch tabs, landing on the far edge', () => {
		expect(gridMove(rows, { row: 2, col: 0 }, 'ArrowLeft')).toEqual({ tab: -1, row: 2, col: 'end' });
		expect(gridMove(rows, { row: 0, col: 2 }, 'ArrowRight')).toEqual({ tab: 1, row: 0, col: 'start' });
	});

	test('Ctrl+Left/Right switch tabs from anywhere and keep the position', () => {
		expect(gridMove(rows, { row: 0, col: 1 }, 'ArrowRight', true)).toEqual({ tab: 1, row: 0, col: 1 });
		expect(gridMove(rows, { row: 0, col: 1 }, 'ArrowLeft', true)).toEqual({ tab: -1, row: 0, col: 1 });
	});

	test('Home/End go to the row ends, or the grid ends with Ctrl', () => {
		expect(gridMove(rows, { row: 2, col: 1 }, 'Home')).toEqual({ row: 2, col: 0 });
		expect(gridMove(rows, { row: 0, col: 0 }, 'End')).toEqual({ row: 0, col: 2 });
		expect(gridMove(rows, { row: 2, col: 1 }, 'Home', true)).toEqual({ row: 0, col: 0 });
		expect(gridMove(rows, { row: 0, col: 0 }, 'End', true)).toEqual({ row: 2, col: 1 });
	});

	test('other keys are not handled', () => {
		expect(gridMove(rows, { row: 0, col: 0 }, 'Enter')).toBe(null);
	});
});

describe('landOn', () => {
	test('clamps into the new grid', () => {
		expect(landOn([4, 2], 5, 'end')).toEqual({ row: 1, col: 1 });
		expect(landOn([4, 2], 0, 'start')).toEqual({ row: 0, col: 0 });
		expect(landOn([4, 2], 1, 3)).toEqual({ row: 1, col: 1 });
		expect(landOn([], 0, 0)).toBe(null);
	});
});

describe('tabStep', () => {
	test('wraps and jumps', () => {
		expect(tabStep(7, 0, 'ArrowLeft')).toBe(6);
		expect(tabStep(7, 6, 'ArrowRight')).toBe(0);
		expect(tabStep(7, 3, 'Home')).toBe(0);
		expect(tabStep(7, 3, 'End')).toBe(6);
		expect(tabStep(7, 3, 'ArrowDown')).toBe(null);
	});
});

describe('initialTab', () => {
	const items = [item('belt', 'a', { section: 'Logistics' }), item('red', 'c', { section: 'Science', n: 3 })];

	test('opens on the first tab that has prints', () => {
		expect(initialTab(items, null)).toBe('Science');
	});

	test('prefers the remembered tab when it still exists', () => {
		expect(initialTab(items, 'Combat')).toBe('Combat');
		expect(initialTab(items, 'Nonsense')).toBe('Science');
	});

	test('falls back to the first tab when nothing has prints', () => {
		expect(initialTab([item('belt', 'a')], null)).toBe(TABS[0].section);
	});
});

describe('printCount', () => {
	test('reads naturally', () => {
		expect(printCount(0)).toBe('no prints yet');
		expect(printCount(1)).toBe('1 print');
		expect(printCount(3)).toBe('3 prints');
	});
});

describe('score', () => {
	test('matches nicknames', () => {
		const red = item('automation-science-pack', 'c', { label: 'Automation science pack', nicknames: ['red science', 'red'] });
		expect(score(red, 'red science')).toBe(100);
		expect(score(red, 'science red')).toBe(10);
		expect(score(red, 'blue')).toBe(0);
	});
});

describe('buildings', () => {
	test('an entity sets uses; an item or fluid sets makes', () => {
		expect(pickParam({ signal: 'entity:foundry' })).toBe('uses');
		expect(pickParam({ signal: 'item:foundry' })).toBe('makes');
		expect(pickParam({ signal: 'fluid:water' })).toBe('makes');
	});

	test('have their own tab, last, and read as "Built with" in the typed list', () => {
		expect(TABS.at(-1)?.section).toBe('Buildings');
		expect(sectionHeading('Buildings')).toBe('Built with');
		expect(sectionHeading('Production')).toBe('Production');
	});
});
