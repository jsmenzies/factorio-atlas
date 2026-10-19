import { env } from 'cloudflare:workers';
import { nicknamesFor } from '#lib/aliases.js';
import { BUILDINGS } from '#lib/server/pipeline/buildings.js';
import { gameData } from '#lib/server/pipeline/game-data.js';
import { parseSearch, searchPrints } from '#lib/server/queries.js';
import { iconSet } from '#lib/server/icon-set.js';
import { sectionOf, type PickerItem } from '#lib/picker.js';
import type { PageServerLoad } from './$types';

/** "item:electronic-circuit" → "electronic-circuit" */
const bare = (signal: string) => signal.slice(signal.indexOf(':') + 1);

export const load: PageServerLoad = async ({ url }) => {
	const params = parseSearch(url);
	const found = await searchPrints(env.DB, params);
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

	const names = new Set([
		...picker.map((p) => p.name),
		...found.results.flatMap((r) => r.outputs.map(bare)),
		...(params.module ? [params.module] : [])
	]);
	// Filter chips can name any entity or recipe, not only the listed ones.
	const entities = [...BUILDINGS.map((b) => b.name), ...(params.uses ? [bare(params.uses)] : [])];
	const icons = iconSet(
		{ item: names, entity: entities, recipe: params.recipe ? [params.recipe] : [] },
		found.results.map((r) => r.title)
	);
	return { params, ...found, icons, picker };
};
