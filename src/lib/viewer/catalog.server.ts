import { gameData, type GameData } from '#lib/server/pipeline/game-data.js';
import type { Catalog } from './extract.js';

/** Viewer prototype lookups backed by the 2.0.55 game data. 1.x names are renamed first. */
export const gameCatalog = (game: GameData = gameData): Catalog => ({
	entity: (name, major) => {
		const proto = major < 2 ? game.migrate('entity', name) : name;
		const e = game.entities[proto];
		if (!e) return null;
		return { proto, type: e.type, size: e.size ?? [1, 1] };
	},
	recipeUsesFluid: (recipe, major) => {
		const r = game.recipes[major < 2 ? game.migrate('recipe', recipe) : recipe];
		if (!r) return false;
		return [...r.ingredients, ...r.results].some(([n]) => game.items[n] === 'fluid');
	}
});
