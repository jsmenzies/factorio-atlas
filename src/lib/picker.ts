/** Item picker entries and matching, shared by the search page loader and its dropdown. */

export interface PickerItem {
	/** Signal id, e.g. "item:advanced-circuit"; "entity:foundry" for a building (picking it sets `uses`, not `makes`). */
	signal: string;
	name: string;
	label: string;
	section: string;
	/** Game sort order within the section. */
	sort: string;
	nicknames: string[];
	/** Prints in the current results that make it (or, for a building, are built with it). */
	n: number;
}

/**
 * Dropdown sections, in display order. Science packs get their own section. Buildings are what
 * prints are built with (`?uses=`); every other section is what they make.
 */
export const SECTIONS = ['Science', 'Intermediates', 'Buildings', 'Logistics', 'Production', 'Space', 'Combat', 'Fluids'] as const;

/** A building ("entity:…"): picking it filters on `uses`, and its icon is the entity's. */
export const isBuilding = (item: Pick<PickerItem, 'signal'>) => item.signal.startsWith('entity:');

/** The search param a picked item sets. */
export const pickParam = (item: Pick<PickerItem, 'signal'>) => (isBuilding(item) ? 'uses' : 'makes');

/** Heading of a section in the typed list: buildings read as "Built with" next to what prints make. */
export const sectionHeading = (section: string) => (section === 'Buildings' ? 'Built with' : section);

export const sectionOf = (name: string, group: string): string | null => {
	if (name.endsWith('-science-pack')) return 'Science';
	return (
		{
			'intermediate-products': 'Intermediates',
			logistics: 'Logistics',
			production: 'Production',
			space: 'Space',
			combat: 'Combat',
			fluids: 'Fluids'
		}[group] ?? null
	);
};

const norm = (s: string) => s.toLowerCase().replace(/[-_]+/g, ' ').trim();

/**
 * How well an item matches typed text; 0 means no match. A nickname typed in full ("red
 * circuits") ranks highest, then names that start with the text, then names containing it.
 */
export const score = (item: PickerItem, query: string): number => {
	const q = norm(query);
	if (!q) return item.n > 0 ? 1 : 0;
	const label = norm(item.label);
	if (item.nicknames.some((nick) => nick === q)) return 100;
	if (label === q) return 90;
	if (label.startsWith(q)) return 60;
	if (item.nicknames.some((nick) => nick.startsWith(q))) return 50;
	if (label.includes(q) || norm(item.name).includes(q)) return 30;
	// Every typed word appears somewhere: "science red" still finds red science.
	const words = q.split(' ');
	const hay = [label, ...item.nicknames].join(' ');
	return words.every((w) => hay.includes(w)) ? 10 : 0;
};

/** "1 print", "3 prints", or "no prints yet": the count shown for a picker item. */
export const printCount = (n: number) => (n ? `${n} print${n === 1 ? '' : 's'}` : 'no prints yet');

/**
 * Crafting-menu tabs for the empty search box, in display order, each with an item icon that
 * stands for it (the sections don't match the game's item groups one to one). The last,
 * Buildings, picks what prints are built with rather than what they make.
 */
export const TABS: readonly { section: (typeof SECTIONS)[number]; icon: string }[] = [
	{ section: 'Logistics', icon: 'transport-belt' },
	{ section: 'Production', icon: 'assembling-machine-2' },
	{ section: 'Intermediates', icon: 'electronic-circuit' },
	{ section: 'Combat', icon: 'submachine-gun' },
	{ section: 'Fluids', icon: 'water' },
	{ section: 'Science', icon: 'automation-science-pack' },
	{ section: 'Space', icon: 'rocket-silo' },
	{ section: 'Buildings', icon: 'oil-refinery' }
];

/** The tab to open on: the viewer's last one if it still exists, else the first that has prints. */
export const initialTab = (items: Pick<PickerItem, 'section' | 'n'>[], remembered: string | null): string => {
	if (remembered && TABS.some((t) => t.section === remembered)) return remembered;
	const withPrints = new Set(items.filter((i) => i.n > 0).map((i) => i.section));
	return (TABS.find((t) => withPrints.has(t.section)) ?? TABS[0]).section;
};

/** Columns in the crafting grid, as in the game. */
export const GRID_COLS = 10;

/**
 * Lay a tab's items out like the game's crafting menu: game order ("group|subgroup|order"
 * compared as plain strings, as the game does), each subgroup on a new row, rows wrapped at `cols`.
 */
export const gridRows = <T extends Pick<PickerItem, 'sort' | 'name'>>(items: T[], cols = GRID_COLS): T[][] => {
	const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
	const sorted = [...items].sort((a, b) => cmp(a.sort, b.sort) || cmp(a.name, b.name));
	const rows: T[][] = [];
	let group: string | null = null;
	for (const item of sorted) {
		const g = item.sort.split('|', 2).join('|');
		const last = rows.at(-1);
		if (!last || g !== group || last.length >= cols) rows.push([item]);
		else last.push(item);
		group = g;
	}
	return rows;
};

export interface Cell {
	row: number;
	col: number;
}

/**
 * Where a key moves focus in a crafting grid whose rows have the given lengths (rows can be short):
 * - Arrow keys step within the grid. Up/Down keep the column, clamped to the target row's length.
 *   Up from the top row returns `{ leave: 'up' }` (focus goes back to the tabs).
 * - Left at a row's start / Right at its end return `{ tab: -1 | 1 }` (previous/next tab), landing on the
 *   same row at the far edge. Ctrl+Left/Right switch tabs from anywhere and keep the position.
 * - Home/End go to the row's first/last item; Ctrl+Home/End to the grid's.
 * - Anything else returns null (not handled).
 */
export type GridMove = Cell | { tab: -1 | 1; row: number; col: number | 'start' | 'end' } | { leave: 'up' } | null;

export const gridMove = (rows: number[], at: Cell, key: string, ctrl = false): GridMove => {
	const last = rows.length - 1;
	const { row, col } = at;
	switch (key) {
		case 'ArrowLeft':
			if (ctrl) return { tab: -1, row, col };
			return col > 0 ? { row, col: col - 1 } : { tab: -1, row, col: 'end' };
		case 'ArrowRight':
			if (ctrl) return { tab: 1, row, col };
			return col < rows[row] - 1 ? { row, col: col + 1 } : { tab: 1, row, col: 'start' };
		case 'ArrowUp':
			return row > 0 ? { row: row - 1, col: Math.min(col, rows[row - 1] - 1) } : { leave: 'up' };
		case 'ArrowDown':
			return row < last ? { row: row + 1, col: Math.min(col, rows[row + 1] - 1) } : at;
		case 'Home':
			return ctrl ? { row: 0, col: 0 } : { row, col: 0 };
		case 'End':
			return ctrl ? { row: last, col: rows[last] - 1 } : { row, col: rows[row] - 1 };
		default:
			return null;
	}
};

/** A cell in a (new) grid near `row`/`col`, clamped so it exists; null when the grid is empty. */
export const landOn = (rows: number[], row: number, col: number | 'start' | 'end'): Cell | null => {
	if (!rows.length) return null;
	const r = Math.min(Math.max(row, 0), rows.length - 1);
	const c = col === 'start' ? 0 : col === 'end' ? rows[r] - 1 : Math.min(Math.max(col, 0), rows[r] - 1);
	return { row: r, col: c };
};

/** Tab index after a tablist key (Left/Right wrap, Home/End); null when the key doesn't move tabs. */
export const tabStep = (count: number, i: number, key: string): number | null => {
	if (key === 'ArrowLeft') return (i - 1 + count) % count;
	if (key === 'ArrowRight') return (i + 1) % count;
	if (key === 'Home') return 0;
	if (key === 'End') return count - 1;
	return null;
};
