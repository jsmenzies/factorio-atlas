/**
 * The "Built with" buildings: the one place that decides which entities the search page offers as
 * a `?uses=` filter (sidebar, the picker's Buildings tab) and counts exactly (`print_uses`,
 * `facet_counts` kind 'uses'). Search itself works for every entity: `facetTokens` indexes a
 * `uses_entity_<name>` token for all of them, so widening this list never needs a re-index.
 */
import { gameData, type GameData } from './game-data';

/**
 * Prototype types worth searching by: crafting machines (assemblers, furnaces, chemical plant,
 * refinery, centrifuge, foundry, EM plant, cryogenic plant, biochamber, recycler, crusher, captive
 * spawner), the rocket silo, labs, mining drills and pumpjacks, beacons, and Space Age infrastructure.
 * Logistics (belts, inserters, pipes, poles, chests), circuits and trains are left out: they're in
 * nearly every print, or have filters of their own.
 */
export const BUILDING_TYPES: ReadonlySet<string> = new Set([
	'assembling-machine',
	'furnace',
	'rocket-silo',
	'lab',
	'mining-drill',
	'beacon',
	'agricultural-tower',
	// Nuclear reactor and heating tower.
	'reactor',
	'fusion-reactor',
	'fusion-generator',
	'asteroid-collector',
	'thruster'
]);

/** A building of those types that a player can place (it has a crafting-menu item; no crash-site props). */
export const isBuilding = (name: string, game: GameData = gameData) => {
	const type = game.entities[name]?.type;
	return type !== undefined && BUILDING_TYPES.has(type) && (game.entityItem[name] ?? name) in game.itemInfo;
};

/** The buildings among a print's entity names, as `entity:<name>` (the `?uses=` value), sorted. */
export const buildingsIn = (entities: Iterable<string>, game: GameData = gameData) =>
	[...entities]
		.filter((n) => isBuilding(n, game))
		.sort()
		.map((n) => `entity:${n}`);

/** Every building, for the picker: entity name, the item that places it (label and game order). */
export const BUILDINGS: readonly { name: string; item: string }[] = Object.keys(gameData.entities)
	.filter((n) => isBuilding(n))
	.map((name) => ({ name, item: gameData.entityItem[name] ?? name }));
