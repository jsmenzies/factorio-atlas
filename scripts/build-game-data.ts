/**
 * Distil the game prototype data the analyzer needs into one committed JSON file, from Factorio's
 * own data dump. Nothing is parsed from Lua: the game runs the data stage and dumps the result.
 *
 * Into one folder (by default the user data dir's `script-output/`), with only the official mods
 * enabled (base, elevated-rails, quality, space-age):
 *
 *   factorio --dump-data                 # data-raw-dump.json
 *   factorio --dump-prototype-locale     # <type>-locale.json: English names
 *
 * The dump doesn't say which mod adds a prototype, so run `factorio --dump-data` three more times,
 * with only base enabled, base + elevated-rails and base + quality, and save each result next to
 * the first as data-raw-dump-base.json, data-raw-dump-elevated-rails.json and
 * data-raw-dump-quality.json. (A `--config` whose `write-data` is a scratch folder and a
 * `--mod-directory` holding just a mod-list.json keep these runs away from your saves and mods.)
 * Then:
 *
 *   bun run game-data <script-output dir> <factorio data dir>
 *
 * The data dir is the game's own `data/` folder: `base/info.json` gives the game version and
 * `base/migrations/` the 1.x→2.0 renames. Writes data/game/game-data-<version>.json.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { GameDataFile, SurfaceCondition } from '#lib/server/pipeline/game-data.js';

const [outputDir, dataDir] = process.argv.slice(2);
if (!outputDir || !dataDir) {
	console.error('usage: bun run game-data <script-output dir> <factorio data dir>');
	process.exit(1);
}

type Proto = Record<string, unknown> & { name: string; type: string };
type Raw = Record<string, Record<string, Proto>>;
const readJson = async <T>(path: string) => JSON.parse(await readFile(path, 'utf8')) as T;

const raw = await readJson<Raw>(join(outputDir, 'data-raw-dump.json'));
/** The game's English names for one prototype category ("item" covers every item type). */
const localeOf = async (category: string) =>
	(await readJson<{ names: Record<string, string> }>(join(outputDir, `${category}-locale.json`))).names;
const locale = {
	item: await localeOf('item'),
	fluid: await localeOf('fluid'),
	recipe: await localeOf('recipe'),
	entity: await localeOf('entity')
};
const { version: gameVersion } = await readJson<{ version: string }>(join(dataDir, 'base', 'info.json'));
const protos = (...types: string[]): Proto[] => types.flatMap((t) => Object.values(raw[t] ?? {}));

/** Prototype types placed in the world as entities (subset of data.raw that blueprints can contain). */
const ENTITY_TYPES = [
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
]; // prettier-ignore
/** Every item prototype type (data.raw keeps each in its own table). */
const ITEM_TYPES = [
	'item', 'ammo', 'armor', 'blueprint', 'blueprint-book', 'capsule', 'copy-paste-tool', 'deconstruction-item',
	'gun', 'item-with-entity-data', 'item-with-inventory', 'item-with-label', 'item-with-tags', 'module',
	'rail-planner', 'repair-tool', 'selection-tool', 'space-platform-starter-pack', 'spidertron-remote', 'tool',
	'upgrade-item'
]; // prettier-ignore
/** What else a blueprint can name: world entities, tiles, recipes and signals. */
const OTHER_NAMED_TYPES = [
	'asteroid', 'asteroid-chunk', 'character', 'cliff', 'fish', 'planet', 'quality', 'recipe', 'resource',
	'segmented-unit', 'simple-entity', 'space-location', 'spider-unit', 'tile', 'unit', 'unit-spawner',
	'virtual-signal'
]; // prettier-ignore
const CRAFTING_MACHINE_TYPES = ['assembling-machine', 'furnace', 'rocket-silo'];

/** Drop float noise from Lua arithmetic (0.44719999999999993 → 0.4472). */
const num = (x: unknown) => Number(Number(x).toPrecision(10));
/** A Lua array; the dump writes an empty table as `{}`. */
const list = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
const byKey = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

// ---- Mod of origin -------------------------------------------------------------------------------
// A prototype comes from the first mod, in load order, whose partial dump has it, even when a later
// mod changed it; space-age, which needs the other three, adds the rest.

const partial = await Promise.all(
	(['base', 'elevated-rails', 'quality'] as const).map(async (mod) => ({
		mod,
		raw: await readJson<Raw>(join(outputDir, `data-raw-dump-${mod}.json`))
	}))
);
const modOf = (p: Proto): string => partial.find(({ raw }) => raw[p.type]?.[p.name])?.mod ?? 'space-age';

// ---- Entities, tiles, names ----------------------------------------------------------------------

const conditions = (p: Proto): SurfaceCondition[] | undefined => {
	const conds = list<{ property: string; min?: number; max?: number }>(p.surface_conditions);
	if (!conds.length) return undefined;
	return conds.map((c) => ({
		property: c.property,
		...(c.min !== undefined && { min: num(c.min) }),
		...(c.max !== undefined && { max: num(c.max) })
	}));
};

type Entity = GameDataFile['entities'][string];
const entities: Record<string, Entity> = {};
for (const p of protos(...ENTITY_TYPES)) {
	const e: Entity = { type: p.type, mod: modOf(p) };
	if (locale.entity[p.name]) e.label = locale.entity[p.name];
	const box = p.collision_box as [[number, number], [number, number]] | undefined;
	if (box) {
		const [[x1, y1], [x2, y2]] = box;
		const size: [number, number] = [Math.max(1, Math.ceil(x2 - x1)), Math.max(1, Math.ceil(y2 - y1))];
		if (size[0] > 1 || size[1] > 1) e.size = size;
	}
	const surface = conditions(p);
	if (surface) e.surface = surface;
	if (p.type === 'beacon') {
		e.supplyArea = num(p.supply_area_distance);
		e.distributionEffectivity = num(p.distribution_effectivity);
		e.distributionEffectivityPerQuality = num(p.distribution_effectivity_bonus_per_quality_level ?? 0);
	}
	const slots = Number(p.module_slots ?? 0);
	if (slots > 0) e.moduleSlots = slots;
	const prod = (p.effect_receiver as { base_effect?: { productivity?: number } } | undefined)?.base_effect?.productivity;
	if (prod) e.baseProductivity = num(prod);
	entities[p.name] = e;
}

const tiles = Object.fromEntries(protos('tile').map((p) => [p.name, modOf(p)]));

// A name can be several prototypes (an item, its entity and its recipe); the earliest mod wins.
const MOD_ORDER = ['base', 'elevated-rails', 'quality', 'space-age'];
const names: Record<string, string> = {};
for (const p of protos(...ENTITY_TYPES, ...ITEM_TYPES, 'fluid', ...OTHER_NAMED_TYPES)) {
	const mod = modOf(p);
	if (!(p.name in names) || MOD_ORDER.indexOf(mod) < MOD_ORDER.indexOf(names[p.name])) names[p.name] = mod;
}

/** Entity → the item that places it: `place_result`, rail planners' `rails`, then `placeable_by`. */
const entityItem: Record<string, string> = {};
const items = protos(...ITEM_TYPES);
for (const p of items) if (typeof p.place_result === 'string') entityItem[p.place_result] ??= p.name;
for (const p of items) for (const r of list<string>(p.rails)) entityItem[r] ??= p.name;
for (const p of protos(...ENTITY_TYPES)) {
	const by = p.placeable_by as { item?: string } | { item?: string }[] | undefined;
	const item = (Array.isArray(by) ? by[0] : by)?.item;
	if (item) entityItem[p.name] ??= item;
}

// ---- Recipes, machines, modules, belts -----------------------------------------------------------

interface Product {
	type: string;
	name: string;
	amount?: number;
	amount_min?: number;
	amount_max?: number;
	probability?: number;
	extra_count_fraction?: number;
}
/** Expected amount per craft: item amounts are whole (the game drops the fraction) plus `extra_count_fraction`. */
const expected = (r: Product) => {
	const base = r.amount ?? ((r.amount_min ?? 0) + (r.amount_max ?? 0)) / 2;
	const whole = r.type === 'item' && r.amount !== undefined ? Math.floor(base) : base;
	return num((whole + (r.extra_count_fraction ?? 0)) * (r.probability ?? 1));
};

const recipes: GameDataFile['recipes'] = {};
for (const p of protos('recipe')) {
	const surface = conditions(p);
	recipes[p.name] = {
		category: (p.category as string | undefined) ?? 'crafting',
		time: num(p.energy_required ?? 0.5),
		productivity: p.allow_productivity === true,
		ingredients: list<Product>(p.ingredients).map((i) => [i.name, num(i.amount)]),
		results: list<Product>(p.results).map((r) => [r.name, expected(r)]),
		...(surface && { surface }),
		...(locale.recipe[p.name] && { label: locale.recipe[p.name] })
	};
}

const machines = Object.fromEntries(
	protos(...CRAFTING_MACHINE_TYPES).map((p) => [
		p.name,
		{ speed: num(p.crafting_speed), moduleSlots: Number(p.module_slots ?? 0), baseProductivity: entities[p.name]?.baseProductivity ?? 0 }
	])
);
const modules = Object.fromEntries(
	protos('module').map((p) => [
		p.name,
		byKey(Object.fromEntries(Object.entries(p.effect as Record<string, number>).map(([k, v]) => [k, num(v)])))
	])
);
const beacon = raw.beacon?.beacon;
if (!beacon) throw new Error('no beacon prototype in the dump');
const belts = Object.fromEntries(protos('transport-belt').map((p) => [p.name, num(p.speed)]));

// ---- Items: type, English name, crafting-menu group and order ------------------------------------

const itemType: Record<string, string> = {};
// Fluids first, so an item wins when both share a name (the parameter-0…9 placeholders).
for (const p of protos('fluid', ...ITEM_TYPES)) itemType[p.name] = p.type;

const subgroups = raw['item-subgroup'];
const groups = raw['item-group'];
const made = new Set(Object.values(recipes).flatMap((r) => r.results.map(([n]) => n)));
/**
 * Left out of the picker data: the game's placeholders, the space platform hub (never built or
 * blueprinted), tools that only live in the cursor or a shortcut (blueprints, planners, wires,
 * remotes), and hidden items that no recipe makes and that place nothing (vehicle guns, the
 * research-progress item).
 */
const notAnItem = (p: Proto) =>
	['item-unknown', 'fluid-unknown', 'no-item', 'space-platform-hub'].includes(p.name) ||
	list<string>(p.flags).some((f) => f === 'only-in-cursor' || f === 'spawnable') ||
	(p.hidden === true && !made.has(p.name) && typeof p.place_result !== 'string');
const label = (p: Proto) => locale[p.type === 'fluid' ? 'fluid' : 'item']?.[p.name];
const itemInfo: GameDataFile['itemInfo'] = {};
const missingLabels: string[] = [];
for (const p of protos(...ITEM_TYPES, 'fluid')) {
	if (notAnItem(p) || p.name in itemInfo) continue;
	const subgroup = subgroups[(p.subgroup as string | undefined) ?? (p.type === 'fluid' ? 'fluid' : 'other')];
	const group = groups[subgroup?.group as string];
	const name = label(p);
	if (!name) missingLabels.push(p.name);
	itemInfo[p.name] = {
		label: name ?? p.name,
		group: group?.name ?? 'other',
		sort: `${group?.order ?? 'z'}|${subgroup?.order ?? 'z'}|${(p.order as string | undefined) ?? ''}`
	};
}

// ---- Planets and surfaces ------------------------------------------------------------------------

const surfaceDefaults = Object.fromEntries(protos('surface-property').map((p) => [p.name, num(p.default_value)]));
const surfaces = Object.fromEntries(
	protos('planet', 'surface')
		.filter((p) => p.surface_properties)
		.map((p) => [p.name, byKey(p.surface_properties as Record<string, number>)])
);

/** What mining a resource or harvesting a plant yields. */
const yields = (p: Proto): string[] => {
	const m = p.minable as { result?: string; results?: Product[] } | undefined;
	return m?.result ? [m.result] : list<Product>(m?.results).map((r) => r.name);
};
/** Raw materials a planet's map has: resources and plants it places, and fluids its oceans pump. */
const native = Object.fromEntries(
	protos('planet').map((planet) => {
		const gen = (planet.map_gen_settings ?? {}) as {
			autoplace_controls?: Record<string, unknown>;
			autoplace_settings?: Record<string, { settings?: Record<string, unknown> }>;
		};
		const controls = new Set(Object.keys(gen.autoplace_controls ?? {}));
		const placed = new Set(Object.keys(gen.autoplace_settings?.entity?.settings ?? {}));
		const found = new Set<string>();
		for (const p of protos('resource', 'plant')) {
			const control = (p.autoplace as { control?: string } | undefined)?.control;
			if (placed.has(p.name) || (control && controls.has(control))) for (const y of yields(p)) found.add(y);
		}
		for (const t of Object.keys(gen.autoplace_settings?.tile?.settings ?? {})) {
			const fluid = raw.tile?.[t]?.fluid;
			if (typeof fluid === 'string') found.add(fluid);
		}
		return [planet.name, found];
	})
);
// Raw items only one planet yields and no planet-side recipe makes: calcite says Vulcanus,
// scrap says Fulgora. Heavy oil is offshore on Fulgora, but refineries make it anywhere.
// Recycling and asteroid crushing (platform-only) don't count as making something; spoiling
// does (Gleba's iron bacteria spoil into iron ore).
const crafted = new Set([
	...Object.values(recipes)
		.filter((r) => r.category !== 'recycling' && r.category !== 'crushing')
		.flatMap((r) => r.results.map(([n]) => n)),
	...items.flatMap((p) => (typeof p.spoil_result === 'string' ? [p.spoil_result] : []))
]);
const planetResources: Record<string, string[]> = {};
for (const [planet, found] of Object.entries(native)) {
	planetResources[planet] = [...found]
		.filter((i) => !crafted.has(i) && Object.entries(native).every(([other, o]) => other === planet || !o.has(i)))
		.sort();
}
for (const s of Object.keys(surfaces)) planetResources[s] ??= [];

// ---- Rename migrations ---------------------------------------------------------------------------
// Applied in the game's order (migrations.txt) to pre-2.0 prints only. 0.17 renamed the science
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
const migDir = join(dataDir, 'base', 'migrations');
const migOrder = (await readFile(join(migDir, 'migrations.txt'), 'utf8')).split(/\r?\n/).map((l) => l.trim());
for (const f of migOrder.filter((f) => f.endsWith('.json') && existsSync(join(migDir, f)))) {
	const m = await readJson<Record<string, [string, string][]>>(join(migDir, f));
	const pick = (k: string) => Object.fromEntries(m[k] ?? []);
	migrations.push({ file: f, entity: pick('entity'), item: pick('item'), recipe: pick('recipe'), tile: pick('tile') });
}
// 1.1 rails load as 2.0's legacy rails; the game does that itself, with no migration file.
migrations.push({
	file: '2.0 legacy rails',
	entity: { 'straight-rail': 'legacy-straight-rail', 'curved-rail': 'legacy-curved-rail' },
	item: {},
	recipe: {},
	tile: {}
});

// ---- Write ---------------------------------------------------------------------------------------

const out: GameDataFile = {
	gameVersion,
	sources: {
		factorio: `Factorio ${gameVersion} --dump-data and --dump-prototype-locale, official mods (base, elevated-rails, quality, space-age)`
	},
	surfaceDefaults: byKey(surfaceDefaults),
	surfaces: byKey(surfaces),
	planetResources: byKey(planetResources),
	recipes: byKey(recipes),
	machines: byKey(machines),
	modules: byKey(modules),
	beaconProfile: (beacon.profile as number[]).map(num),
	belts: byKey(belts),
	items: byKey(itemType),
	entities: byKey(entities),
	tiles: byKey(tiles),
	names: byKey(names),
	itemInfo: byKey(itemInfo),
	entityItem: byKey(entityItem),
	migrations
};

const dest = join(import.meta.dirname, '..', 'data', 'game', `game-data-${gameVersion}.json`);
await writeFile(dest, JSON.stringify(out) + '\n');
console.log(
	`wrote ${relative(process.cwd(), dest)}: ${Object.keys(entities).length} entities, ${Object.keys(tiles).length} tiles, ` +
		`${Object.keys(names).length} names, ${Object.keys(recipes).length} recipes, ${Object.keys(itemInfo).length} items`
);
if (missingLabels.length) console.warn(`no English name for: ${missingLabels.join(', ')}`);
