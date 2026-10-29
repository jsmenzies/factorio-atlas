import { gameData, type GameData } from '#lib/server/pipeline/game-data.js';
import type { Catalog } from './extract.js';

/** Viewer prototype lookups backed by the game data. Names from older versions are renamed first. */
export const gameCatalog = (game: GameData = gameData): Catalog => ({
	entity: (name, saved) => {
		const proto = game.migrate('entity', name, saved);
		const e = game.entities[proto];
		if (!e) return null;
		return { proto, type: e.type, size: e.size ?? [1, 1] };
	},
	recipeUsesFluid: (recipe, saved) => {
		const r = game.recipes[game.migrate('recipe', recipe, saved)];
		if (!r) return false;
		return [...r.ingredients, ...r.results].some(([n]) => game.items[n] === 'fluid');
	}
});
