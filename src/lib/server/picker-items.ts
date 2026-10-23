import { nicknamesFor } from '#lib/aliases.js';
import { sectionOf, type PickerItem } from '#lib/picker.js';
import { BUILDINGS } from '#lib/server/pipeline/buildings.js';
import { gameData } from '#lib/server/pipeline/game-data.js';

/**
 * Everything the search dropdown offers: every craftable item and fluid, then the buildings prints
 * are built with (Buildings tab), with how many results make or use each. The same list decides
 * which `makes`/`uses` landing pages exist (lib/search-seo.ts).
 */
export const pickerItems = (makes: Record<string, number>, uses: Record<string, number>): PickerItem[] => {
	const picker: PickerItem[] = Object.entries(gameData.itemInfo).flatMap(([name, info]) => {
		const section = sectionOf(name, info.group);
		// "science" is the game's hidden research-progress item; no blueprint makes it.
		if (!section || name === 'science') return [];
		const signal = `${gameData.items[name] === 'fluid' ? 'fluid' : 'item'}:${name}`;
		return [{ signal, name, label: info.label, section, sort: info.sort, nicknames: nicknamesFor(name), n: makes[signal] ?? 0 }];
	});
	// The buildings, in the game order of the items that place them.
	for (const { name, item } of BUILDINGS) {
		const info = gameData.itemInfo[item];
		const signal = `entity:${name}`;
		picker.push({
			signal,
			name,
			label: info.label,
			section: 'Buildings',
			sort: info.sort,
			nicknames: nicknamesFor(item),
			n: uses[signal] ?? 0
		});
	}
	return picker;
};
