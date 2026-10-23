import { nicknamesFor } from '#lib/aliases.js';
import type { IconSet } from '#lib/icons.js';
import { sectionOf, TABS, type PickerEntry } from '#lib/picker.js';
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
