/**
 * Distil the game prototype data the analyzer needs into one committed JSON file.
 *
 *   git clone --depth 1 --branch 2.0.55 https://github.com/wube/factorio-data <dir>
 *   curl -o <km.json> https://raw.githubusercontent.com/KirkMcDonald/kirkmcdonald.github.io/master/data/space-age-2.0.55.json
 *   bun scripts/build-game-data.ts <dir> <km.json>
 *
 * Two sources, pinned to the same game version:
 * - KirkMcDonald calculator JSON: recipes, crafting machines, modules, beacon, belts, planets.
 * - wube/factorio-data Lua sources, regex-scanned (never executed): every prototype name
 *   and its mod, plus entity type, size and surface_conditions, and the rename migrations.
 *
 * The scan misses entities that Lua helper functions build, so the analyzer also treats item and
 * recipe names as known.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import type { GameDataFile, SurfaceCondition } from '#lib/server/pipeline/game-data.js';

const [fdDir, kmPath] = process.argv.slice(2);
if (!fdDir || !kmPath) {
	console.error('usage: bun scripts/build-game-data.ts <factorio-data checkout> <kirkmcdonald json>');
	process.exit(1);
}

const MOD_DIRS = ['core', 'base', 'elevated-rails', 'quality', 'space-age'];

/** Prototype types placed in the world as entities (subset of data.raw that blueprints can contain). */
const ENTITY_TYPES = new Set([
	'accumulator', 'agricultural-tower', 'ammo-turret', 'arithmetic-combinator', 'artillery-turret',
	'artillery-wagon', 'assembling-machine', 'asteroid-collector', 'beacon', 'boiler', 'burner-generator',
	'car', 'cargo-bay', 'cargo-landing-pad', 'cargo-wagon', 'constant-combinator', 'container',
	'curved-rail-a', 'curved-rail-b', 'decider-combinator', 'display-panel', 'electric-energy-interface',
	'electric-pole', 'electric-turret', 'elevated-curved-rail-a', 'elevated-curved-rail-b',
	'elevated-half-diagonal-rail', 'elevated-straight-rail', 'fluid-turret', 'fluid-wagon', 'furnace',
	'fusion-generator', 'fusion-reactor', 'gate', 'generator', 'half-diagonal-rail', 'heat-interface',
	'heat-pipe', 'infinity-cargo-wagon', 'infinity-container', 'infinity-pipe', 'inserter', 'lab', 'lamp',
	'land-mine', 'lane-splitter', 'legacy-curved-rail', 'legacy-straight-rail', 'lightning-attractor',
	'linked-belt', 'linked-container', 'loader', 'loader-1x1', 'locomotive', 'logistic-container',
	'mining-drill', 'offshore-pump', 'pipe', 'pipe-to-ground', 'plant', 'power-switch',
	'programmable-speaker', 'proxy-container', 'pump', 'radar', 'rail-chain-signal', 'rail-ramp',
	'rail-signal', 'rail-support', 'reactor', 'roboport', 'rocket-silo', 'selector-combinator',
	'simple-entity-with-force', 'simple-entity-with-owner', 'solar-panel', 'space-platform-hub',
	'spider-vehicle', 'splitter', 'storage-tank', 'straight-rail', 'thruster', 'train-stop',
	'transport-belt', 'tree', 'turret', 'underground-belt', 'valve', 'wall'
]); // prettier-ignore

const HEAD = /\btype\s*=\s*"([a-z0-9_-]+)"\s*,\s*name\s*=\s*"([A-Za-z0-9_-]+)"/g;
const COLLISION = /\bcollision_box\s*=\s*\{\s*\{\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\}\s*,\s*\{\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\}/;
const SUPPLY = /\bsupply_area_distance\s*=\s*([\d.]+)/;
const DIST_EFF = /\bdistribution_effectivity\s*=\s*([\d.]+)/;
const DIST_Q = /\bdistribution_effectivity_bonus_per_quality_level\s*=\s*([\d.]+)/;
const BASE_PROD = /base_effect\s*=\s*\{\s*productivity\s*=\s*([\d.]+)/;
/** `surface_conditions = { {...}, ... }`; the inner tables hold no braces. */
const SURFACE = /surface_conditions\s*=\s*(\{(?:\s*\{[^{}]*\}\s*,?)+\s*\})/;
/** `data.raw["type"]["name"].surface_conditions = <table or helper()>` in data-updates files. */
const RAW_SURFACE = /data\.raw\["([a-z0-9-]+)"\]\["([a-z0-9-]+)"\]\.surface_conditions\s*=\s*(\{(?:\s*\{[^{}]*\}\s*,?)+\s*\}|[a-z_]+\(\))/g;
const LOCAL_FN = /local function ([a-z_]+)\(\)\s*return\s*(\{(?:\s*\{[^{}]*\}\s*,?)+\s*\})/g;

const parseConditions = (table: string): SurfaceCondition[] =>
	[...table.matchAll(/\{([^{}]*)\}/g)].flatMap(([, body]) => {
		const property = body.match(/property\s*=\s*"([a-z-]+)"/)?.[1];
		if (!property) return [];
		const num = (k: string) => {
			const m = body.match(new RegExp(`\\b${k}\\s*=\\s*(-?[\\d.]+)`));
			return m ? Number(m[1]) : undefined;
		};
		return [{ property, ...(num('min') !== undefined && { min: num('min') }), ...(num('max') !== undefined && { max: num('max') }) }];
	});

async function* luaFiles(dir: string): AsyncGenerator<string> {
	for (const e of await readdir(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* luaFiles(p);
		else if (e.name.endsWith('.lua')) yield p;
	}
}

type Entity = GameDataFile['entities'][string];
const names: Record<string, string> = {};
const entities: Record<string, Entity> = {};
const tiles: Record<string, string> = {};
/** Entity → the item that places it, for icons: `place_result`, plus rail planners' `rails` lists. */
const entityItem: Record<string, string> = {};
const surfaceOverrides: [string, SurfaceCondition[], string][] = [];

for (const mod of MOD_DIRS) {
	for await (const file of luaFiles(join(fdDir, mod))) {
		const text = await readFile(file, 'utf8');
		const heads = [...text.matchAll(HEAD)];
		heads.forEach((m, i) => {
			const [, type, name] = m;
			const end = heads[i + 1]?.index ?? Math.min(text.length, m.index + 20000);
			const block = text.slice(m.index, end);
			// First definition wins: base defines most things, DLC mods add rather than redefine.
			names[name] ??= mod;
			if (type === 'tile') tiles[name] ??= mod;
			const head = block.slice(0, 3000);
			const placed = head.match(/\bplace_result\s*=\s*"([a-z0-9-]+)"/)?.[1];
			if (placed) entityItem[placed] ??= name;
			for (const r of head.match(/\brails\s*=\s*\{([^}]*)\}/)?.[1].matchAll(/"([a-z0-9-]+)"/g) ?? []) entityItem[r[1]] ??= name;
			if (!ENTITY_TYPES.has(type) || entities[name]) return;
			const e: Entity = { type, mod };
			const c = block.match(COLLISION);
			if (c) {
				const [x1, y1, x2, y2] = c.slice(1).map(Number);
				const size: [number, number] = [Math.max(1, Math.ceil(x2 - x1)), Math.max(1, Math.ceil(y2 - y1))];
				if (size[0] > 1 || size[1] > 1) e.size = size;
			}
			const sc = block.slice(0, 6000).match(SURFACE);
			if (sc) e.surface = parseConditions(sc[1]);
			if (type === 'beacon') {
				e.supplyArea = Number(block.match(SUPPLY)?.[1] ?? 3);
				e.distributionEffectivity = Number(block.match(DIST_EFF)?.[1] ?? 1.5);
				e.distributionEffectivityPerQuality = Number(block.match(DIST_Q)?.[1] ?? 0);
			}
			const bp = block.match(BASE_PROD);
			if (bp) e.baseProductivity = Number(bp[1]);
			entities[name] = e;
		});
		const helpers = Object.fromEntries([...text.matchAll(LOCAL_FN)].map((m) => [`${m[1]}()`, m[2]]));
		for (const m of text.matchAll(RAW_SURFACE)) {
			const table = m[3].endsWith('()') ? helpers[m[3]] : m[3];
			if (table) surfaceOverrides.push([m[2], parseConditions(table), relative(fdDir, file)]);
		}
	}
}
for (const [name, conds] of surfaceOverrides) if (entities[name]) entities[name].surface = conds;

// space-age/base-data-updates.lua sets this in a Lua loop the regex can't follow:
// every vanilla chest needs gravity >= 0.1, so none can be placed on a platform.
const updates = await readFile(join(fdDir, 'space-age', 'base-data-updates.lua'), 'utf8');
if (!/local containers = [\s\S]{0,400}"wooden-chest"[\s\S]{0,900}property = "gravity",\s*min = 0\.1/.test(updates)) {
	throw new Error('space-age/base-data-updates.lua container loop changed; re-check chest surface_conditions');
}
for (const n of ['wooden-chest', 'iron-chest', 'steel-chest', 'passive-provider-chest', 'active-provider-chest',
	'storage-chest', 'buffer-chest', 'requester-chest']) {
	entities[n].surface = [{ property: 'gravity', min: 0.1 }];
} // prettier-ignore

// Rename migrations, applied in file order to pre-2.0 prints only. 0.17 renamed the science
// packs, but its migration files no longer ship with 2.0, so that step is written out here.
const science017 = {
	'science-pack-1': 'automation-science-pack',
	'science-pack-2': 'logistic-science-pack',
	'science-pack-3': 'chemical-science-pack',
	'high-tech-science-pack': 'utility-science-pack'
};
const migrations: GameDataFile['migrations'] = [
	{ file: '0.17.0 (science pack renames)', entity: {}, item: science017, recipe: science017, tile: {} }
];
const migDir = join(fdDir, 'base', 'migrations');
for (const f of (await readdir(migDir)).filter((f) => f.endsWith('.json')).sort()) {
	const m = JSON.parse(await readFile(join(migDir, f), 'utf8')) as Record<string, [string, string][]>;
	const pick = (k: string) => Object.fromEntries(m[k] ?? []);
	migrations.push({ file: f, entity: pick('entity'), item: pick('item'), recipe: pick('recipe'), tile: pick('tile') });
}
// 1.1 rails become legacy rails in 2.0. That happens in 2.0.0.lua, not the JSON.
migrations.push({
	file: '2.0.0.lua',
	entity: { 'straight-rail': 'legacy-straight-rail', 'curved-rail': 'legacy-curved-rail' },
	item: {},
	recipe: {},
	tile: {}
});

interface Km {
	recipes: {
		key: string;
		icon_col: number;
		icon_row: number;
		category: string;
		energy_required: number;
		allow_productivity: boolean;
		ingredients: { name: string; amount: number }[];
		results: { name: string; amount: number; probability?: number }[];
		surface_conditions?: SurfaceCondition[];
	}[];
	crafting_machines: { key: string; crafting_speed: number; module_slots: number; prod_bonus?: number; crafting_categories: string[] }[];
	rocket_silo: Km['crafting_machines'];
	modules: { item_key: string; effect: Record<string, number> }[];
	beacon: { profile: number[]; distribution_effectivity: number };
	belts: { key: string; speed: number }[];
	items: {
		key: string;
		type: string;
		icon_col: number;
		icon_row: number;
		localized_name: { en: string };
		group: string;
		subgroup: string;
		order: string;
	}[];
	groups: Record<string, { order: string; subgroups: Record<string, string> }>;
	sprites: { hash: string; width: number; height: number };
	planets: { key: string; surface_properties: Record<string, number>; resources: Record<string, string[]> }[];
	surface_properties: { name: string; default_value: number }[];
	resources: { key: string; results: { name: string }[] }[];
	plants: { key: string; results: { name: string }[] }[];
	spoilage: { from_item: string; to_item: string }[];
}
const km = JSON.parse(await readFile(kmPath, 'utf8')) as Km;

// Raw items only one planet yields and no planet-side recipe makes: calcite says Vulcanus,
// scrap says Fulgora. Heavy oil is offshore on Fulgora, but refineries make it anywhere.
// Recycling and asteroid crushing (platform-only) don't count as making something; spoiling
// does (Gleba's iron bacteria spoil into iron ore).
const yields = Object.fromEntries([...km.resources, ...km.plants].map((r) => [r.key, r.results.map((x) => x.name)]));
const crafted = new Set([
	...km.recipes.filter((r) => r.category !== 'recycling' && r.category !== 'crushing').flatMap((r) => r.results.map((x) => x.name)),
	...km.spoilage.map((s) => s.to_item)
]);
const native = Object.fromEntries(
	km.planets.map((p) => [
		p.key,
		new Set(
			Object.values(p.resources)
				.flat()
				.flatMap((r) => yields[r] ?? [r])
		)
	])
);
const planetResources = Object.fromEntries(
	Object.entries(native).map(([planet, items]) => [
		planet,
		[...items].filter((i) => !crafted.has(i) && Object.entries(native).every(([other, o]) => other === planet || !o.has(i))).sort()
	])
);

const out: GameDataFile = {
	gameVersion: '2.0.55',
	sources: {
		kirkmcdonald: `KirkMcDonald/kirkmcdonald.github.io data/${basename(kmPath)}`,
		factorioData: 'wube/factorio-data@2.0.55 (regex scan)'
	},
	surfaceDefaults: Object.fromEntries(km.surface_properties.map((p) => [p.name, p.default_value])),
	surfaces: Object.fromEntries(km.planets.map((p) => [p.key, p.surface_properties])),
	planetResources,
	recipes: Object.fromEntries(
		km.recipes.map((r) => [
			r.key,
			{
				category: r.category,
				time: r.energy_required,
				productivity: r.allow_productivity,
				ingredients: r.ingredients.map((i) => [i.name, i.amount] as [string, number]),
				// Expected amount: probability folded in.
				results: r.results.map((x) => [x.name, x.amount * (x.probability ?? 1)] as [string, number]),
				...(r.surface_conditions && { surface: r.surface_conditions })
			}
		])
	),
	machines: Object.fromEntries(
		[...km.crafting_machines, ...km.rocket_silo].map((m) => [
			m.key,
			{ speed: m.crafting_speed, moduleSlots: m.module_slots, baseProductivity: entities[m.key]?.baseProductivity ?? m.prod_bonus ?? 0 }
		])
	),
	modules: Object.fromEntries(km.modules.map((m) => [m.item_key, m.effect])),
	beaconProfile: km.beacon.profile,
	belts: Object.fromEntries(km.belts.map((b) => [b.key, b.speed])),
	items: Object.fromEntries(km.items.map((i) => [i.key, i.type])),
	entities: Object.fromEntries(Object.entries(entities).sort(([a], [b]) => a.localeCompare(b))),
	tiles: Object.fromEntries(Object.entries(tiles).sort(([a], [b]) => a.localeCompare(b))),
	names: Object.fromEntries(Object.entries(names).sort(([a], [b]) => a.localeCompare(b))),
	migrations,
	// For item pickers: English name, crafting-menu tab, and a sort key matching the game's order.
	itemInfo: Object.fromEntries(
		km.items.map((i) => [
			i.key,
			{
				label: i.localized_name.en,
				group: i.group,
				sort: `${km.groups[i.group]?.order ?? 'z'}|${km.groups[i.group]?.subgroups[i.subgroup] ?? 'z'}|${i.order}`
			}
		])
	),
	// KirkMcDonald's calculator publishes one sprite sheet of 32px icons per data version.
	icons: {
		sheet: {
			url: `https://kirkmcdonald.github.io/images/sprite-sheet-${km.sprites.hash}.png`,
			width: km.sprites.width,
			height: km.sprites.height,
			size: 32
		},
		item: Object.fromEntries(km.items.map((i) => [i.key, [i.icon_col, i.icon_row] as [number, number]])),
		recipe: Object.fromEntries(km.recipes.map((r) => [r.key, [r.icon_col, r.icon_row] as [number, number]])),
		// Legacy (1.x) and elevated rails are placed by rail planners the scan doesn't follow;
		// the rail item stands in.
		entityItem: {
			...Object.fromEntries(
				[
					'legacy-straight-rail',
					'legacy-curved-rail',
					'elevated-straight-rail',
					'elevated-half-diagonal-rail',
					'elevated-curved-rail-a',
					'elevated-curved-rail-b'
				].map((r) => [r, 'rail'])
			),
			...entityItem
		}
	}
};

const dest = join(import.meta.dirname, '..', 'data', 'game', `game-data-${out.gameVersion}.json`);
await writeFile(dest, JSON.stringify(out) + '\n');
console.log(
	`wrote ${relative(process.cwd(), dest)}: ${Object.keys(out.entities).length} entities, ${Object.keys(out.tiles).length} tiles, ` +
		`${Object.keys(out.names).length} names, ${Object.keys(out.recipes).length} recipes, ${surfaceOverrides.length} surface overrides`
);
