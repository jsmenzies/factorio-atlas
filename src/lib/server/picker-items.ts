import { nicknamesFor } from '#lib/aliases.js';
import type { IconSet } from '#lib/icons.js';
import { sectionOf, TABS, type PickerEntry } from '#lib/picker.js';
import { landingPath } from '#lib/search-seo.js';
import { iconSet } from '#lib/server/icon-set.js';
import { BUILDINGS } from '#lib/server/pipeline/buildings.js';
import { gameData } from '#lib/server/pipeline/game-data.js';

/**
 * Everything the search dropdown offers: every craftable item and fluid, then the buildings prints
 * are built with (Buildings tab). The same list decides which `makes`/`uses` landing pages exist
 * (lib/search-seo.ts). Counts are per search (`withCounts` in lib/picker.ts).
 */
const buildEntries = (): PickerEntry[] => {
	const picker: PickerEntry[] = Object.entries(gameData.itemInfo).flatMap(([name, info]) => {
		const section = sectionOf(name, info.group);
		// "science" is the game's hidden research-progress item; no blueprint makes it.
		if (!section || name === 'science') return [];
		const signal = `${gameData.items[name] === 'fluid' ? 'fluid' : 'item'}:${name}`;
		return [{ signal, name, label: info.label, section, sort: info.sort, nicknames: nicknamesFor(name) }];
	});
	// The buildings, in the game order of the items that place them.
	for (const { name, item } of BUILDINGS) {
		const info = gameData.itemInfo[item];
		picker.push({
			signal: `entity:${name}`,
			name,
			label: info.label,
			section: 'Buildings',
			sort: info.sort,
			nicknames: nicknamesFor(item)
		});
	}
	return picker;
};

// Fixed for a build, so made once per isolate.
let entries: PickerEntry[] | undefined;
let picker: { items: PickerEntry[]; icons: IconSet } | undefined;

export const pickerEntries = () => (entries ??= buildEntries());

/** The picker as the search page gets it: its entries and their icons, with the tabs' icons. */
export const searchPicker = () =>
	(picker ??= {
		items: pickerEntries(),
		icons: iconSet({ item: TABS.map((t) => t.icon), signals: pickerEntries().map((p) => p.signal) })
	});

export interface LandingLink {
	signal: string;
	label: string;
	href: string;
}

/** At most this many links of each kind: the tabs list everything. */
const LANDING_LINKS = 6;

/**
 * Links from a print to the landing pages of what it makes and the buildings it's built with: only values
 * the picker has (so the page exists and is indexed) and the print's own search tokens hold (`outputs`, and
 * `entities` for `uses`), so every landing lists this print. Makes only what a recipe in it crafts
 * (`products`): an output that is only a page's icon (a cargo wagon on a train station) gets no link.
 * Makes in `ranked` order first (the page's own ranking: main products, then the rest), then any other
 * outputs; buildings by how many the print places. Crawlers reach landing pages through these, as every
 * other link into search is nofollow and blocked in robots.txt.
 */
export const landingLinks = (
	a: { outputs: string[]; products: string[]; entities: Record<string, number> },
	ranked: string[] = []
): { makes: LandingLink[]; uses: LandingLink[] } => {
	const bySignal = new Map(pickerEntries().map((p) => [p.signal, p]));
	const link = (key: 'makes' | 'uses', signal: string): LandingLink[] => {
		const p = bySignal.get(signal);
		if (!p || (key === 'makes') === (p.section === 'Buildings')) return [];
		return [{ signal, label: p.label, href: landingPath({ key, value: signal }) }];
	};
	const buildings = Object.entries(a.entities)
		.sort(([x, m], [y, n]) => n - m || x.localeCompare(y))
		.map(([name]) => `entity:${name}`);
	return {
		makes: [...new Set([...ranked, ...a.outputs])]
			.filter((s) => a.outputs.includes(s) && a.products.includes(s))
			.flatMap((s) => link('makes', s))
			.slice(0, LANDING_LINKS),
		uses: buildings.flatMap((s) => link('uses', s)).slice(0, LANDING_LINKS)
	};
};
