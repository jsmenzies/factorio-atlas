import file from '../../../../data/game/game-data-2.1.23.json';

/** A surface property bound, e.g. `{property: 'pressure', min: 10}`. */
export interface SurfaceCondition {
	property: string;
	min?: number;
	max?: number;
}

/** Shape of `data/game/game-data-<version>.json`, written by scripts/build-game-data.ts. */
export interface GameDataFile {
	gameVersion: string;
	sources: Record<string, string>;
	surfaceDefaults: Record<string, number>;
	/** Planet (and `space-platform`) surface properties; missing keys take the default. */
	surfaces: Record<string, Record<string, number>>;
	/** Raw items only that planet yields and no recipe makes, e.g. calcite → vulcanus. */
	planetResources: Record<string, string[]>;
	recipes: Record<
		string,
		{
			/** Crafting categories it can be made in (2.1 allows several). */
			categories: string[];
			/** Seconds per craft at crafting speed 1. */
			time: number;
			productivity: boolean;
			ingredients: [string, number][];
			/** Expected amounts, with probabilities folded in. */
			results: [string, number][];
			surface?: SurfaceCondition[];
			/** English name. */
			label?: string;
		}
	>;
	machines: Record<string, { speed: number; moduleSlots: number; baseProductivity: number }>;
	modules: Record<string, Record<string, number>>;
	beaconProfile: number[];
	/** Belt speed in tiles per tick; × 480 gives items/s for both lanes. */
	belts: Record<string, number>;
	/** Item and fluid names to their prototype type. */
	items: Record<string, string>;
	entities: Record<
		string,
		{
			type: string;
			mod: string;
			/** English name. */
			label?: string;
			/** Tiles, before rotation. Omitted when 1×1. */
			size?: [number, number];
			surface?: SurfaceCondition[];
			baseProductivity?: number;
			supplyArea?: number;
			distributionEffectivity?: number;
			distributionEffectivityPerQuality?: number;
			/** Module slots (machines, beacons, drills, labs); omitted when none. */
			moduleSlots?: number;
		}
	>;
	tiles: Record<string, string>;
	/** Every prototype name a blueprint can contain (entities, items, fluids, recipes, tiles, signals), to the mod that adds it. */
	names: Record<string, string>;
	/** Item picker data: English name, crafting-menu group, and the game's sort order. */
	itemInfo: Record<string, { label: string; group: string; sort: string }>;
	/** Entity name → the item that places it, when they differ ("straight-rail" → "rail"). */
	entityItem: Record<string, string>;
	migrations: {
		file: string;
		/** Applies to names saved in a game version before this one, `major.minor`. */
		before: string;
		entity: Record<string, string>;
		item: Record<string, string>;
		recipe: Record<string, string>;
		tile: Record<string, string>;
	}[];
}

/** Mods that ship with the Space Age DLC. */
export const DLC_MODS = new Set(['space-age', 'quality', 'recycler', 'elevated-rails']);

export interface GameData extends GameDataFile {
	/** Whether a name exists in vanilla + Space Age as any prototype. */
	known: (name: string) => boolean;
	/** Which mod defines a name, if any. */
	modOf: (name: string) => string | undefined;
	/** Rename a name saved in game version `saved` ([major, minor]) to its current name. */
	migrate: (kind: 'entity' | 'item' | 'recipe' | 'tile', name: string, saved: readonly [number, number]) => string;
}

/** Whether a name saved in `[major, minor]` predates `before` ("2.1"). */
const savedBefore = ([major, minor]: readonly [number, number], before: string) => {
	const [bMajor, bMinor] = before.split('.').map(Number);
	return major < bMajor || (major === bMajor && minor < bMinor);
};

export const loadGameData = (f: GameDataFile): GameData => ({
	...f,
	known: (n) => n in f.names || n in f.items || n in f.recipes || n in f.entities || n in f.tiles,
	modOf: (n) => f.entities[n]?.mod ?? f.tiles[n] ?? f.names[n],
	// Recipes and placeable entities share their item's name, and the migration files often
	// list a rename only under `item`.
	migrate: (kind, name, saved) =>
		f.migrations.reduce((n, m) => (savedBefore(saved, m.before) ? (m[kind][n] ?? (kind === 'tile' ? undefined : m.item[n]) ?? n) : n), name)
});

// The generator writes this file from a typed `GameDataFile`; JSON inference widens its tuples.
export const gameData: GameData = loadGameData(file as unknown as GameDataFile);
