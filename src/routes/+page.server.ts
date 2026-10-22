import { env } from 'cloudflare:workers';
import { nicknamesFor } from '#lib/aliases.js';
import { retryBusy } from '#lib/server/admin/busy.js';
import { BUILDINGS } from '#lib/server/pipeline/buildings.js';
import { gameData } from '#lib/server/pipeline/game-data.js';
import { parseSearch, searchPrints } from '#lib/server/queries.js';
import { iconSet } from '#lib/server/icon-set.js';
import { sectionOf, TABS, type PickerItem } from '#lib/picker.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const params = parseSearch(url);
	// One batch; locally a render or backfill run can hold the database's lock for a moment (busy.ts).
	const found = await retryBusy(() => searchPrints(env.DB, params));
	const makes = Object.fromEntries(found.facets.makes.map((f) => [f.value, f.n]));
	const uses = Object.fromEntries(found.facets.uses.map((f) => [f.value, f.n]));

	// Every craftable item and fluid, for the search dropdown, with how many results make it.
	const picker: PickerItem[] = Object.entries(gameData.itemInfo).flatMap(([name, info]) => {
		const section = sectionOf(name, info.group);
		// "science" is the game's hidden research-progress item; no blueprint makes it.
		if (!section || name === 'science') return [];
		const signal = `${gameData.items[name] === 'fluid' ? 'fluid' : 'item'}:${name}`;
		return [{ signal, name, label: info.label, section, sort: info.sort, nicknames: nicknamesFor(name), n: makes[signal] ?? 0 }];
	});
	// The buildings prints are built with (Buildings tab), in the game order of the items that place them.
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

	// The picker's items and tabs, results' outputs, facets, and filter chips (which can name anything).
	const icons = iconSet(
		{
			item: [...TABS.map((t) => t.icon), ...params.module],
			recipe: params.recipe,
			signals: [
				...picker.map((p) => p.signal),
				...found.results.flatMap((r) => r.outputs),
				...found.facets.makes.map((f) => f.value),
				...found.facets.uses.map((f) => f.value),
				...params.makes,
				...params.takes,
				...params.uses
			]
		},
		found.results.map((r) => r.title)
	);
	return { params, ...found, icons, picker };
};
