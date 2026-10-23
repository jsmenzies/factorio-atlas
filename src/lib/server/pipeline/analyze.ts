import { decodeGameVersion } from './decode';
import { DLC_MODS, gameData as defaultGameData, type GameData, type SurfaceCondition } from './game-data';

/**
 * Bump when the analyzer's output changes so stored prints can be re-analyzed
 * from the raw store without re-downloading.
 */
export const ANALYZER_VERSION = 7;

// Game facts (names, sizes, recipes, surface conditions) come from `game-data.ts`, pinned to
// one game version. Older prints are renamed to 2.0 names first; newer ones may have names
// the data doesn't know yet, which is why "unknown" only implies "modded" for 2.0 prints.

/** Machines that strongly suggest which planet a design is for, though they can be placed elsewhere. */
const PLANET_HINTS: Record<string, string> = {
	foundry: 'vulcanus',
	'big-mining-drill': 'vulcanus',
	'electromagnetic-plant': 'fulgora',
	'lightning-rod': 'fulgora',
	'lightning-collector': 'fulgora',
	recycler: 'fulgora',
	biochamber: 'gleba',
	'agricultural-tower': 'gleba',
	'heating-tower': 'aquilo',
	'cryogenic-plant': 'aquilo',
	'fusion-reactor': 'aquilo'
};

const TILE_PLANET_HINTS: Record<string, string> = {
	'ice-platform': 'aquilo',
	'artificial-yumako-soil': 'gleba',
	'artificial-jellynut-soil': 'gleba',
	'overgrowth-yumako-soil': 'gleba',
	'overgrowth-jellynut-soil': 'gleba'
};

/** Tiles that can only be laid on a space platform. */
const TILE_SURFACE: Record<string, SurfaceCondition[]> = {
	'space-platform-foundation': [{ property: 'gravity', max: 0 }]
};

/** Seed table: name prefixes to the mod that adds them. Only applied to names the game data doesn't know. */
const MOD_PREFIXES: [RegExp, string][] = [
	[/^kr-/, 'Krastorio2'],
	[/^se-/, 'space-exploration'],
	[/^bob/, 'bobs-mods'],
	[/^angels-/, 'angels-mods'],
	[/^(ltn-|logistic-train-stop)/, 'LogisticTrainNetwork'],
	[/^cybersyn/, 'cybersyn'],
	[/^(miniloader|hps__ml-)/, 'miniloader'],
	[/^aai-/, 'aai'],
	[/^py/, 'pymods'],
	[/^nullius-/, 'nullius'],
	[/^ee-/, 'EditorExtensions'],
	[/^textplate-/, 'textplates'],
	[/^factory-/, 'Factorissimo'],
	[/^ll-/, 'LunarLandings'],
	[/^maraxsis/, 'maraxsis'],
	[/^cerys/, 'Cerys-Moon-of-Fulgora']
];

const QUALITY_LEVEL: Record<string, number> = { normal: 0, uncommon: 1, rare: 2, epic: 3, legendary: 5 };
/** Productivity can't exceed +300% in 2.0. */
const MAX_PRODUCTIVITY = 3;
/** Speed penalties can't push a machine below 20% speed. */
const MIN_SPEED = 0.2;

const isCombinator = (name: string) => name.endsWith('-combinator');
const isBelt = (name: string) => /(^|-)transport-belt$/.test(name);
const isRail = (name: string) => /rail/.test(name) && !/signal/.test(name);

/** What a group of entities is for. A page's role is its dominant category. */
export type Category =
	| 'production'
	| 'mining'
	| 'research'
	| 'belts'
	| 'inserters'
	| 'fluids'
	| 'power'
	| 'circuits'
	| 'rail'
	| 'defence'
	| 'bots'
	| 'storage'
	| 'platform'
	| 'other';

const CATEGORY_BY_TYPE: Record<string, Category> = {
	'assembling-machine': 'production', furnace: 'production', 'rocket-silo': 'production',
	'agricultural-tower': 'production', beacon: 'production',
	'mining-drill': 'mining', 'offshore-pump': 'mining',
	lab: 'research',
	'transport-belt': 'belts', 'underground-belt': 'belts', splitter: 'belts', 'lane-splitter': 'belts',
	loader: 'belts', 'loader-1x1': 'belts', 'linked-belt': 'belts',
	inserter: 'inserters',
	pipe: 'fluids', 'pipe-to-ground': 'fluids', pump: 'fluids', 'storage-tank': 'fluids', valve: 'fluids',
	'electric-pole': 'power', 'solar-panel': 'power', accumulator: 'power', boiler: 'power', generator: 'power',
	reactor: 'power', 'heat-pipe': 'power', 'burner-generator': 'power', 'fusion-reactor': 'power',
	'fusion-generator': 'power', 'lightning-attractor': 'power', 'power-switch': 'power',
	'arithmetic-combinator': 'circuits', 'decider-combinator': 'circuits', 'constant-combinator': 'circuits',
	'selector-combinator': 'circuits', 'display-panel': 'circuits', 'programmable-speaker': 'circuits', lamp: 'circuits',
	'straight-rail': 'rail', 'curved-rail-a': 'rail', 'curved-rail-b': 'rail', 'half-diagonal-rail': 'rail',
	'legacy-straight-rail': 'rail', 'legacy-curved-rail': 'rail', 'elevated-straight-rail': 'rail',
	'elevated-curved-rail-a': 'rail', 'elevated-curved-rail-b': 'rail', 'elevated-half-diagonal-rail': 'rail',
	'rail-ramp': 'rail', 'rail-support': 'rail', 'rail-signal': 'rail', 'rail-chain-signal': 'rail',
	'train-stop': 'rail', locomotive: 'rail', 'cargo-wagon': 'rail', 'fluid-wagon': 'rail', 'artillery-wagon': 'rail',
	'ammo-turret': 'defence', 'electric-turret': 'defence', 'fluid-turret': 'defence', 'artillery-turret': 'defence',
	turret: 'defence', wall: 'defence', gate: 'defence', 'land-mine': 'defence', radar: 'defence',
	roboport: 'bots', 'logistic-container': 'bots',
	container: 'storage', 'proxy-container': 'storage', 'linked-container': 'storage',
	'space-platform-hub': 'platform', thruster: 'platform', 'asteroid-collector': 'platform', 'cargo-bay': 'platform',
	'cargo-landing-pad': 'platform'
}; // prettier-ignore

/** Modded entities aren't in the game data, so guess from the name. */
const CATEGORY_BY_NAME: [RegExp, Category][] = [
	[/belt|splitter|loader/, 'belts'],
	[/inserter/, 'inserters'],
	[/pipe|pump|tank/, 'fluids'],
	[/rail|train|locomotive|wagon/, 'rail'],
	[/turret|wall|gate/, 'defence'],
	[/pole|substation|solar|accumulator|generator|boiler|reactor/, 'power'],
	[/combinator/, 'circuits'],
	[/chest|container|warehouse/, 'storage'],
	[/drill/, 'mining'],
	[/furnace|assembl|refinery|plant|smelter/, 'production']
];

export type Role = Category | 'empty';

/** Categories that only support other things: they never decide a page's role on their own. */
const SUPPORTING = new Set<Category>(['inserters', 'other']);

type Json = Record<string, unknown>;
type Counts = Record<string, number>;
type Version = [number, number, number, number];

const bump = (c: Counts, k: string, n = 1) => {
	c[k] = (c[k] ?? 0) + n;
};
const asArray = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const sortCounts = (c: Counts): Counts => Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export type NodeKind = 'blueprint' | 'blueprint_book' | 'upgrade_planner' | 'deconstruction_planner';

export interface NodeAnalysis {
	path: string;
	kind: NodeKind;
	label: string | null;
	description: string | null;
	gameVersion: string | null;
	icons: string[];
	entityCount: number;
	tileCount: number;
	/** Bounding box of entity collision boxes and tiles. Unknown (modded) entities count as 1×1. */
	width: number | null;
	height: number | null;
	/** Entity, recipe, module and tile names, renamed to 2.0 names for pre-2.0 prints. */
	entities: Counts;
	recipes: Counts;
	modules: Counts;
	tiles: Counts;
	qualities: Counts;
	wires: { red: number; green: number; copper: number };
	combinators: number;
	/** Constant combinators with no wires: authors use these as signs naming belt contents. */
	signs: number;
	circuitControlled: number;
	/** Items named by unwired constant combinators (usually the design's belt inputs/outputs). */
	signItems: string[];
	/** What the page makes: its icons, or its recipe products when the icons name no item. */
	outputs: string[];
	/** What the page takes: sign items and recipe ingredients that nothing on the page makes. */
	inputs: string[];
	/** Everything the page's recipes make and nothing on the page consumes. */
	products: string[];
	/** Made and consumed on the page. */
	intermediates: string[];
	/** A rate stated in the label, e.g. "Chemical Science 0.75/s", in items per second. */
	claimedRate: number | null;
	/**
	 * Nameplate net flow per item per second: positive is made, negative is consumed. Assumes
	 * full input supply; furnaces (no stored recipe) and mining drills aren't counted.
	 */
	rates: Counts;
	/** `rates` of the first output, to compare with `claimedRate`. */
	estimatedRate: number | null;
	/** Furnaces and recyclers, which pick their recipe from their input and store none. */
	furnacesWithoutRecipe: number;
	/** What the page is for: production when it crafts anything, else its dominant category. */
	role: Role;
	/** Entity counts grouped by category, for infra summaries (belts, trains, power, ...). */
	byCategory: Partial<Record<Category, Counts>>;
	/** Items/s on one fully compressed belt (both lanes) of the fastest tier used; null without belts. */
	beltThroughput: number | null;
	trainStops: { name: string | null; limit: number | null }[];
	schedules: number;
	richText: string[];
	signals: string[];
}

export interface PrintAnalysis {
	analyzerVersion: number;
	/** Game data the analysis used, e.g. "2.0.77". */
	gameDataVersion: string;
	rootKind: NodeKind;
	gameVersion: string | null;
	gameMajor: number | null;
	blueprintCount: number;
	bookCount: number;
	maxDepth: number;
	entityCount: number;
	tileCount: number;
	entities: Counts;
	recipes: Counts;
	modules: Counts;
	tiles: Counts;
	qualities: Counts;
	beacons: number;
	wires: { red: number; green: number; copper: number };
	combinators: number;
	signs: number;
	trainStops: string[];
	belts: Counts;
	requiresSpaceAge: boolean;
	spaceAgeEvidence: string[];
	usesQuality: boolean;
	usesCircuits: boolean;
	usesTrains: boolean;
	usesElevatedRails: boolean;
	/** Where the print is meant for: one surface if surface conditions force it, else hints that fit. */
	planets: string[];
	/** Every surface where all its entities, recipes and tiles can be placed; null before 2.0. */
	placeableOn: string[] | null;
	/** What limits placement, e.g. "entity:roboport" (not on platforms). */
	surfaceEvidence: string[];
	mods: string[];
	/** Entity, recipe, module and tile names the game data doesn't know. */
	unknownNames: string[];
	labels: string[];
	/** Union of per-page outputs/inputs, for "makes X" / "takes X" search. */
	outputs: string[];
	inputs: string[];
	products: string[];
	/** Highest nameplate output per item across pages, items/s. Pages are often alternatives, so not summed. */
	rates: Counts;
	/** A single page's role, or the most common role across a book's pages. */
	role: Role;
	/** How many pages have each role. */
	roles: Counts;
	byCategory: Partial<Record<Category, Counts>>;
	beltThroughput: number | null;
	/** Game versions named in the title, description or labels, e.g. "1.1", "2.0". */
	claimedVersions: string[];
	claimedPlanets: string[];
	stageGuess: 'early' | 'mid' | 'late' | 'endgame' | null;
	limits: string[];
	nodes: NodeAnalysis[];
}

const RICH_TEXT = /\[(item|entity|recipe|fluid|virtual-signal|technology|planet|quality|space-location|tile)=([^\]]+)]/g;

const richTextRefs = (...texts: (string | null | undefined)[]): string[] => {
	const out = new Set<string>();
	for (const t of texts) {
		if (!t) continue;
		for (const m of t.matchAll(RICH_TEXT)) out.add(`${m[1]}:${m[2]}`);
	}
	return [...out];
};

const versionString = (v: Version | null) => (v ? `${v[0]}.${v[1]}.${v[2]}` : null);

interface ModuleUse {
	name: string;
	quality: string;
	count: number;
}

/** 1.x stored modules as {name: count}; 2.0 uses insert plans. */
const moduleList = (items: unknown, rename: (n: string) => string): ModuleUse[] => {
	const out: ModuleUse[] = [];
	if (Array.isArray(items)) {
		for (const plan of items as Json[]) {
			const id = (plan.id ?? {}) as Json;
			const name = rename(str(id.name) ?? '');
			if (!name.includes('module')) continue;
			const inv = asArray(((plan.items ?? {}) as Json).in_inventory);
			const count = inv.reduce((s, p) => s + (typeof p.count === 'number' ? p.count : 1), 0) || 1;
			out.push({ name, quality: str(id.quality) ?? 'normal', count });
		}
	} else if (items && typeof items === 'object') {
		for (const [raw, n] of Object.entries(items as Counts)) {
			const name = rename(raw);
			if (name.includes('module') && typeof n === 'number') out.push({ name, quality: 'normal', count: n });
		}
	}
	return out;
};

/** Module effects with quality applied: quality scales the good effects only. */
const moduleEffects = (mods: ModuleUse[], game: GameData): Counts => {
	const out: Counts = {};
	for (const m of mods) {
		const q = 1 + 0.3 * (QUALITY_LEVEL[m.quality] ?? 0);
		for (const [k, v] of Object.entries(game.modules[m.name] ?? {})) {
			const good = k === 'speed' || k === 'productivity' || k === 'quality' ? v > 0 : v < 0;
			bump(out, k, v * (good ? q : 1) * m.count);
		}
	}
	return out;
};

/**
 * Collect signal ids from control_behavior. Signals live under keys like
 * `first_signal`, `output_signal` or `signal` (1.x and 2.0), or in constant
 * combinator filter/section lists.
 */
const signalsIn = (cb: unknown, into: Set<string>) => {
	const walk = (v: unknown, key: string, depth: number) => {
		if (depth > 8 || !v || typeof v !== 'object') return;
		if (Array.isArray(v)) return v.forEach((x) => walk(x, key, depth + 1));
		const o = v as Json;
		const signalish = key.includes('signal') || key === 'filters';
		if (signalish && typeof o.name === 'string') into.add(`${str(o.type) ?? 'item'}:${o.name}`);
		for (const [k, x] of Object.entries(o)) walk(x, k, depth + 1);
	};
	walk(cb, '', 0);
};

/** entity_numbers that have any circuit wire attached (1.x per-entity or 2.0 top-level). */
const wiredEntities = (bp: Json, ents: Json[]): Set<number> => {
	const out = new Set<number>();
	if (Array.isArray(bp.wires)) {
		for (const w of bp.wires as unknown[][]) {
			// Copper (power) wires don't make an entity part of a circuit.
			if (typeof w[1] === 'number' && w[1] <= 4) out.add(w[0] as number);
			if (typeof w[3] === 'number' && w[3] <= 4) out.add(w[2] as number);
		}
	}
	for (const e of ents) {
		const conns = e.connections as Record<string, unknown> | undefined;
		if (!conns || typeof conns !== 'object') continue;
		for (const c of Object.values(conns)) {
			if (c && typeof c === 'object' && !Array.isArray(c) && ((c as Json).red || (c as Json).green)) {
				out.add(e.entity_number as number);
			}
		}
	}
	return out;
};

const RATE = /(\d+(?:[.,]\d+)?)\s*(?:items?\s*)?\/\s*(s|sec|second|m|min|minute)\b/i;

/** "Chemical Science 0.75/s" → 0.75; "2700/m" → 45. Items per second. */
export const parseRate = (label: string | null | undefined): number | null => {
	const m = label?.match(RATE);
	if (!m) return null;
	const n = Number(m[1].replace(',', '.'));
	return m[2].toLowerCase().startsWith('s') ? n : n / 60;
};

const VERSION_MENTION = /(?<![\d.])(0\.1[5-8]|1\.[01]|2\.[01])(?:\.\d+)?(?!\d)/g;

/** Versions a human claims compatibility with; "1.0-2.0" yields 1.0 and 2.0. */
export const claimedVersions = (...texts: (string | null | undefined)[]): string[] => {
	const out = new Set<string>();
	for (const t of texts) for (const m of t?.matchAll(VERSION_MENTION) ?? []) out.add(m[1]);
	return [...out].sort((a, b) => Number(a) - Number(b));
};

const PLANET_MENTION = /\b(nauvis|vulcanus|fulgora|gleba|aquilo)\b/gi;

/** Planets a human names in text, including [planet=x] rich text. */
export const claimedPlanets = (...texts: (string | null | undefined)[]): string[] => {
	const out = new Set<string>();
	for (const t of texts) for (const m of t?.matchAll(PLANET_MENTION) ?? []) out.add(m[1].toLowerCase());
	return [...out].sort();
};

type Box = [number, number, number, number];
const overlaps = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

interface Machine {
	name: string;
	recipe: string;
	quality: string;
	modules: ModuleUse[];
	box: Box;
}
interface Beacon {
	box: Box;
	effects: Counts;
}

/**
 * Nameplate crafting: every machine runs flat out. Beacons follow 2.0 rules (distribution
 * effectivity × the diminishing profile) for 2.0 prints, and 1.x rules (0.5 each, no
 * profile) before that. Ignores research productivity, belts and inserters.
 */
const nameplateRates = (machines: Machine[], beacons: Beacon[], major: number, game: GameData, signal: (n: string) => string) => {
	const flows: Counts = {};
	for (const m of machines) {
		const machine = game.machines[m.name];
		const recipe = game.recipes[m.recipe];
		if (!machine || !recipe) continue;
		const eff = moduleEffects(m.modules, game);
		const hits = beacons.filter((b) => overlaps(b.box, m.box));
		const profile = major >= 2 ? (game.beaconProfile[Math.min(hits.length, game.beaconProfile.length) - 1] ?? 1) : 1;
		for (const b of hits) for (const [k, v] of Object.entries(b.effects)) bump(eff, k, v * profile);
		const speed = Math.max(MIN_SPEED, 1 + (eff.speed ?? 0));
		const prod = recipe.productivity ? Math.min(MAX_PRODUCTIVITY, Math.max(0, machine.baseProductivity + (eff.productivity ?? 0))) : 0;
		const crafts = (machine.speed * (1 + 0.3 * (QUALITY_LEVEL[m.quality] ?? 0)) * speed) / Math.max(recipe.time, 1e-9);
		for (const [n, a] of recipe.ingredients) bump(flows, signal(n), -a * crafts);
		for (const [n, a] of recipe.results) bump(flows, signal(n), a * crafts * (1 + prod));
	}
	return Object.fromEntries(
		Object.entries(flows)
			.filter(([, v]) => Math.abs(v) > 1e-6)
			.map(([k, v]) => [k, round3(v)])
	);
};

const analyzeBlueprint = (path: string, bp: Json, inherited: Version | null, game: GameData): NodeAnalysis => {
	const v = decodeGameVersion(bp.version) ?? inherited;
	const major = v?.[0] ?? 2;
	const rename = (kind: 'entity' | 'item' | 'recipe' | 'tile') => (n: string) => (major < 2 ? game.migrate(kind, n) : n);
	const renameEntity = rename('entity');
	const renameItem = rename('item');
	const renameRecipe = rename('recipe');
	const renameTile = rename('tile');
	const signal = (n: string) => `${game.items[n] === 'fluid' ? 'fluid' : 'item'}:${n}`;
	// 1.x has 8 directions (east = 2), 2.0 has 16 (east = 4).
	const sideways = (d: unknown) => (major < 2 ? d === 2 || d === 6 : d === 4 || d === 12);

	const ents = asArray(bp.entities);
	const tiles = asArray(bp.tiles);

	const entities: Counts = {};
	const recipes: Counts = {};
	const modules: Counts = {};
	const tileCounts: Counts = {};
	const qualities: Counts = {};
	const signals = new Set<string>();
	const trainStops: NodeAnalysis['trainStops'] = [];
	const machines: Machine[] = [];
	const beacons: Beacon[] = [];
	let combinators = 0;
	let circuitControlled = 0;
	let furnacesWithoutRecipe = 0;
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	const extend = (b: Box) => {
		minX = Math.min(minX, b[0]);
		minY = Math.min(minY, b[1]);
		maxX = Math.max(maxX, b[2]);
		maxY = Math.max(maxY, b[3]);
	};

	const wires = { red: 0, green: 0, copper: 0 };
	const wired = wiredEntities(bp, ents);
	const constantSignals: string[][] = [];

	for (const e of ents) {
		const name = renameEntity(str(e.name) ?? 'unknown');
		const proto = game.entities[name];
		bump(entities, name);
		const pos = e.position as { x?: number; y?: number } | undefined;
		let box: Box | null = null;
		if (typeof pos?.x === 'number' && typeof pos.y === 'number') {
			let [w, h] = proto?.size ?? [1, 1];
			if (sideways(e.direction)) [w, h] = [h, w];
			box = [pos.x - w / 2, pos.y - h / 2, pos.x + w / 2, pos.y + h / 2];
			extend(box);
		}
		const recipeRaw = str(e.recipe);
		const recipe = recipeRaw ? renameRecipe(recipeRaw) : undefined;
		if (recipe) bump(recipes, recipe);
		const mods = moduleList(e.items, renameItem);
		for (const m of mods) bump(modules, m.quality !== 'normal' ? `${m.name}@${m.quality}` : m.name, m.count);
		const q = str(e.quality) ?? 'normal';
		if (q !== 'normal') bump(qualities, q);
		const rq = str(e.recipe_quality);
		if (rq && rq !== 'normal') bump(qualities, rq);
		if (box && recipe) machines.push({ name, recipe, quality: q, modules: mods, box });
		if (proto?.type === 'furnace') furnacesWithoutRecipe++;
		if (box && proto?.type === 'beacon') {
			const reach = proto.supplyArea ?? 3;
			const de =
				major >= 2
					? (proto.distributionEffectivity ?? 1.5) + (proto.distributionEffectivityPerQuality ?? 0) * (QUALITY_LEVEL[q] ?? 0)
					: 0.5;
			const effects = Object.fromEntries(Object.entries(moduleEffects(mods, game)).map(([k, x]) => [k, x * de]));
			beacons.push({ box: [box[0] - reach, box[1] - reach, box[2] + reach, box[3] + reach], effects });
		}
		if (isCombinator(name)) combinators++;
		else if (e.control_behavior) circuitControlled++;
		if (e.control_behavior) signalsIn(e.control_behavior, signals);
		if (name === 'constant-combinator' && !wired.has(e.entity_number as number)) {
			const own = new Set<string>();
			signalsIn(e.control_behavior, own);
			constantSignals.push([...own]);
		}
		if (name === 'train-stop' || typeof e.station === 'string') {
			trainStops.push({
				name: str(e.station) ?? null,
				limit: typeof e.manual_trains_limit === 'number' ? e.manual_trains_limit : null
			});
		}
		// 1.x stores circuit wires per entity, on both ends.
		const conns = e.connections as Record<string, unknown> | undefined;
		if (conns && typeof conns === 'object') {
			for (const c of Object.values(conns)) {
				if (Array.isArray(c)) wires.copper += c.length;
				else if (c && typeof c === 'object') {
					wires.red += asArray((c as Json).red).length;
					wires.green += asArray((c as Json).green).length;
				}
			}
		}
		if (Array.isArray(e.neighbours)) wires.copper += e.neighbours.length;
	}
	if (!Array.isArray(bp.wires)) {
		wires.red = Math.round(wires.red / 2);
		wires.green = Math.round(wires.green / 2);
		wires.copper = Math.round(wires.copper / 2);
	} else {
		// 2.0: [src_entity, src_connector, dst_entity, dst_connector]; 1/3 red, 2/4 green, 5+ copper.
		for (const w of bp.wires as unknown[][]) {
			const id = w[1];
			if (id === 1 || id === 3) wires.red++;
			else if (id === 2 || id === 4) wires.green++;
			else wires.copper++;
		}
	}

	for (const t of tiles) {
		bump(tileCounts, renameTile(str(t.name) ?? 'unknown'));
		const pos = t.position as { x?: number; y?: number } | undefined;
		if (typeof pos?.x === 'number' && typeof pos.y === 'number') extend([pos.x, pos.y, pos.x + 1, pos.y + 1]);
	}

	// Recipe set algebra: what the page's machines make and use.
	const made = new Set<string>();
	const used = new Set<string>();
	for (const r of Object.keys(recipes)) {
		const rec = game.recipes[r];
		if (!rec) continue;
		rec.results.forEach(([n]) => made.add(signal(n)));
		rec.ingredients.forEach(([n]) => used.add(signal(n)));
	}
	const products = [...made].filter((s) => !used.has(s)).sort();
	const intermediates = [...made].filter((s) => used.has(s)).sort();
	const recipeInputs = [...used].filter((s) => !made.has(s));

	const label = str(bp.label) ?? null;
	const description = str(bp.description) ?? null;
	const icons = asArray(bp.icons).map((ic) => {
		const sig = (ic.signal ?? {}) as Json;
		const type = str(sig.type) ?? 'item';
		return `${type}:${type === 'item' ? renameItem(str(sig.name) ?? '') : str(sig.name)}`;
	});
	const hasExtent = Number.isFinite(minX);
	const signItems = [...new Set(constantSignals.flat().map((s) => (s.startsWith('item:') ? `item:${renameItem(s.slice(5))}` : s)))].filter(
		(s) => s.startsWith('item:') || s.startsWith('fluid:')
	);
	// The first icon is conventionally the product. Extra icons are outputs too, unless the
	// label says the page takes them as input ("Logistic Science (Gear-input)").
	// An icon naming a machine placed in the print ("kr-fuel-refinery") describes it, not its product.
	const iconItems = icons.filter(
		(i) =>
			(i.startsWith('item:') || i.startsWith('fluid:')) && !(entities[i.slice(i.indexOf(':') + 1)] && !recipes[i.slice(i.indexOf(':') + 1)])
	);
	const labelSaysInput = /\binput\b/i.test(label ?? '');
	const iconOutputs = labelSaysInput ? iconItems.slice(0, 1) : iconItems;
	const iconInputs = labelSaysInput ? iconItems.slice(1) : [];
	// Icons say what the author means the page to make. Recipe products fill in when they
	// don't, but would otherwise add by-products such as a platform's own thruster fuel.
	const outputs = iconOutputs.length ? iconOutputs : products;
	const rates = nameplateRates(machines, beacons, major, game, signal);
	const firstRate = outputs[0] ? rates[outputs[0]] : undefined;

	const byCategory: Partial<Record<Category, Counts>> = {};
	for (const [name, n] of Object.entries(entities)) {
		const type = game.entities[name]?.type;
		const cat = (type ? CATEGORY_BY_TYPE[type] : undefined) ?? CATEGORY_BY_NAME.find(([re]) => re.test(name))?.[1] ?? 'other';
		bump((byCategory[cat] ??= {}), name, n);
	}
	// Weigh by area, not count: three 3×3 labs say more about a page than ten belts feeding them.
	const area = (name: string) => (game.entities[name]?.size ?? [1, 1]).reduce((a, b) => a * b, 1);
	const weight = (c: Category) =>
		Object.entries(byCategory[c] ?? {}).reduce((w, [name, n]) => {
			// Poles are everywhere, and signs are labels: neither makes a page "power" or "circuits".
			if (c === 'power' && game.entities[name]?.type === 'electric-pole') return w;
			const count = name === 'constant-combinator' ? n - constantSignals.length : n;
			return w + count * area(name);
		}, 0);
	const crafts = Object.keys(recipes).length > 0 || furnacesWithoutRecipe > 0;
	const ranked = (Object.keys(byCategory) as Category[])
		.filter((c) => !SUPPORTING.has(c))
		.map((c) => [c, weight(c)] as const)
		.filter(([, w]) => w > 0)
		.sort((a, b) => b[1] - a[1]);
	const role: Role = crafts ? 'production' : (ranked[0]?.[0] ?? (byCategory.power ? 'power' : ents.length ? 'other' : 'empty'));
	const beltSpeeds = Object.keys(entities).flatMap((n) => (game.belts[n] ? [game.belts[n]] : []));

	return {
		path,
		kind: 'blueprint',
		label,
		description,
		gameVersion: versionString(v),
		icons,
		entityCount: ents.length,
		tileCount: tiles.length,
		width: hasExtent ? Math.round(maxX - minX) : null,
		height: hasExtent ? Math.round(maxY - minY) : null,
		entities: sortCounts(entities),
		recipes: sortCounts(recipes),
		modules: sortCounts(modules),
		tiles: sortCounts(tileCounts),
		qualities,
		wires,
		combinators,
		signs: constantSignals.length,
		circuitControlled,
		signItems: signItems.sort(),
		outputs,
		inputs: [...new Set([...signItems, ...iconInputs, ...recipeInputs])].filter((i) => !outputs.includes(i) && !made.has(i)).sort(),
		products,
		intermediates,
		claimedRate: parseRate(label),
		rates,
		estimatedRate: firstRate && firstRate > 0 ? firstRate : null,
		furnacesWithoutRecipe,
		role,
		byCategory: Object.fromEntries(Object.entries(byCategory).map(([c, counts]) => [c, sortCounts(counts)])),
		// Belt speed is tiles per tick: 8 items per tile per lane × 2 lanes × 60 ticks = × 480.
		beltThroughput: beltSpeeds.length ? Math.round(Math.max(...beltSpeeds) * 480) : null,
		trainStops,
		schedules: asArray(bp.schedules).length,
		richText: richTextRefs(label, description),
		signals: [...signals].sort()
	};
};

const emptyNode = (path: string, kind: NodeKind, body: Json, inherited: Version | null, game: GameData): NodeAnalysis => ({
	...analyzeBlueprint(path, {}, inherited, game),
	kind,
	label: str(body.label) ?? null,
	description: str(body.description) ?? null,
	gameVersion: versionString(decodeGameVersion(body.version) ?? inherited),
	icons: asArray(body.icons).map((ic) => {
		const sig = (ic.signal ?? {}) as Json;
		return `${str(sig.type) ?? 'item'}:${str(sig.name)}`;
	}),
	richText: richTextRefs(str(body.label), str(body.description)),
	width: null,
	height: null
});

const KINDS: NodeKind[] = ['blueprint', 'blueprint_book', 'upgrade_planner', 'deconstruction_planner'];
const MAX_DEPTH = 32;

function* walk(obj: Json, path: number[], inherited: Version | null, game: GameData): Generator<[NodeAnalysis, number]> {
	if (path.length > MAX_DEPTH) return;
	const kind = KINDS.find((k) => k in obj);
	if (!kind) return;
	const body = (obj[kind] ?? {}) as Json;
	const p = path.join('/');
	if (kind === 'blueprint') {
		yield [analyzeBlueprint(p, body, inherited, game), path.length];
		return;
	}
	yield [emptyNode(p, kind, body, inherited, game), path.length];
	if (kind === 'blueprint_book') {
		const version = decodeGameVersion(body.version) ?? inherited;
		for (const child of asArray(body.blueprints)) {
			const idx = typeof child.index === 'number' ? child.index : 0;
			yield* walk(child, [...path, idx], version, game);
		}
	}
}

const stageGuess = (a: Pick<PrintAnalysis, 'entities' | 'modules' | 'requiresSpaceAge' | 'planets'>) => {
	const has = (re: RegExp) => Object.keys(a.entities).some((n) => re.test(n));
	if (a.planets.some((p) => p === 'aquilo') || has(/^fusion-/)) return 'endgame';
	if (a.requiresSpaceAge || has(/^(beacon|rocket-silo)$/) || Object.keys(a.modules).some((m) => m.includes('-3'))) return 'late';
	if (has(/^(express-|assembling-machine-3|electric-furnace|bulk-inserter|stack-inserter|oil-refinery)/)) return 'mid';
	if (Object.keys(a.entities).length > 0) return 'early';
	return null;
};

/** Surfaces where every condition holds. */
const placeable = (conds: SurfaceCondition[], game: GameData) =>
	Object.entries(game.surfaces)
		.filter(([, props]) =>
			conds.every((c) => {
				const v = props[c.property] ?? game.surfaceDefaults[c.property] ?? 0;
				return (c.min === undefined || v >= c.min) && (c.max === undefined || v <= c.max);
			})
		)
		.map(([s]) => s)
		.sort();

/** Analyze a decoded exchange-string payload. Pure; safe to run in a Worker. */
export const analyzePrint = (decoded: unknown, game: GameData = defaultGameData): PrintAnalysis => {
	const root = (decoded ?? {}) as Json;
	const nodes: NodeAnalysis[] = [];
	let maxDepth = 0;
	for (const [n, depth] of walk(root, [], null, game)) {
		nodes.push(n);
		maxDepth = Math.max(maxDepth, depth);
	}
	const prints = nodes.filter((n) => n.kind === 'blueprint');

	const entities: Counts = {};
	const recipes: Counts = {};
	const modules: Counts = {};
	const tiles: Counts = {};
	const qualities: Counts = {};
	const rates: Counts = {};
	const wires = { red: 0, green: 0, copper: 0 };
	const trainStops = new Set<string>();
	let combinators = 0;
	let signs = 0;
	let furnacesWithoutRecipe = 0;
	const outputs = new Set<string>();
	const inputs = new Set<string>();
	const products = new Set<string>();
	const roles: Counts = {};
	const byCategory: Partial<Record<Category, Counts>> = {};
	let beltThroughput: number | null = null;
	for (const n of prints) {
		bump(roles, n.role);
		for (const [c, counts] of Object.entries(n.byCategory) as [Category, Counts][])
			for (const [k, v] of Object.entries(counts)) bump((byCategory[c] ??= {}), k, v);
		if (n.beltThroughput) beltThroughput = Math.max(beltThroughput ?? 0, n.beltThroughput);
		for (const [k, v] of Object.entries(n.entities)) bump(entities, k, v);
		for (const [k, v] of Object.entries(n.recipes)) bump(recipes, k, v);
		for (const [k, v] of Object.entries(n.modules)) bump(modules, k, v);
		for (const [k, v] of Object.entries(n.tiles)) bump(tiles, k, v);
		for (const [k, v] of Object.entries(n.qualities)) bump(qualities, k, v);
		for (const [k, v] of Object.entries(n.rates)) if (v > 0) rates[k] = Math.max(rates[k] ?? 0, v);
		wires.red += n.wires.red;
		wires.green += n.wires.green;
		wires.copper += n.wires.copper;
		combinators += n.combinators;
		signs += n.signs;
		furnacesWithoutRecipe += n.furnacesWithoutRecipe;
		n.outputs.forEach((o) => outputs.add(o));
		n.inputs.forEach((i) => inputs.add(i));
		n.products.forEach((p) => products.add(p));
		for (const s of n.trainStops) if (s.name) trainStops.add(s.name);
	}

	const versions = nodes.map((n) => n.gameVersion).filter((v): v is string => !!v);
	const gameVersion = nodes[0]?.gameVersion ?? versions[0] ?? null;
	const [gameMajor, gameMinor] = gameVersion ? gameVersion.split('.').map(Number) : [null, null];
	const is2x = (gameMajor ?? 0) >= 2;
	// "Unknown means modded" only holds when the print matches the game data's version.
	const [dataMajor, dataMinor] = game.gameVersion.split('.').map(Number);
	const sameVersionAsData = gameMajor === dataMajor && gameMinor === dataMinor;

	const names = Object.keys(entities);
	const moduleNames = [...new Set(Object.keys(modules).map((m) => m.split('@')[0]))];
	const unknownNames = [...new Set([...names, ...Object.keys(recipes), ...moduleNames, ...Object.keys(tiles)])]
		.filter((n) => !game.known(n))
		.sort();

	const dlc = (kind: string, list: string[], modOf: (n: string) => string | undefined) =>
		list.filter((n) => DLC_MODS.has(modOf(n) ?? '')).map((n) => `${kind}:${n}`);
	const spaceAgeEvidence = is2x
		? [
				...dlc('entity', names, game.modOf),
				...dlc('recipe', Object.keys(recipes), (n) => game.names[n]),
				...dlc('tile', Object.keys(tiles), game.modOf),
				...dlc('module', moduleNames, game.modOf),
				...Object.keys(qualities).map((q) => `quality:${q}`)
			]
		: [];

	// Placement: surface_conditions on entities, on recipes being crafted, and platform-only tiles.
	let placeableOn: string[] | null = null;
	const surfaceEvidence: string[] = [];
	const planets = new Set<string>();
	if (is2x) {
		const conds: [string, SurfaceCondition[]][] = [];
		const add = (src: string, c: SurfaceCondition[] | undefined) => c && conds.push([src, c]);
		for (const n of names) add(`entity:${n}`, game.entities[n]?.surface);
		for (const r of Object.keys(recipes)) add(`recipe:${r}`, game.recipes[r]?.surface);
		for (const t of Object.keys(tiles)) add(`tile:${t}`, TILE_SURFACE[t]);
		const everywhere = Object.keys(game.surfaces).length;
		for (const [src, c] of conds) if (placeable(c, game).length < everywhere) surfaceEvidence.push(src);
		placeableOn = placeable(
			conds.flatMap(([, c]) => c),
			game
		);

		// Hints say what a design is for when placement alone doesn't decide it.
		const hints = new Set<string>();
		for (const n of names) if (PLANET_HINTS[n]) hints.add(PLANET_HINTS[n]);
		for (const t of Object.keys(tiles)) if (TILE_PLANET_HINTS[t]) hints.add(TILE_PLANET_HINTS[t]);
		const consumed = new Set([
			...[...inputs].map((i) => i.slice(i.indexOf(':') + 1)),
			...Object.keys(recipes).flatMap((r) => game.recipes[r]?.ingredients.map(([n]) => n) ?? [])
		]);
		for (const [planet, raw] of Object.entries(game.planetResources)) if (raw.some((r) => consumed.has(r))) hints.add(planet);

		if (placeableOn.length === 1) planets.add(placeableOn[0]);
		else for (const h of hints) if (placeableOn.length === 0 || placeableOn.includes(h)) planets.add(h);
	}

	const mods = new Set<string>();
	for (const n of unknownNames) {
		const mod = MOD_PREFIXES.find(([re]) => re.test(n))?.[1];
		if (mod) mods.add(mod);
		else if (sameVersionAsData) mods.add('unknown-mod');
	}

	const belts = Object.fromEntries(Object.entries(entities).filter(([n]) => isBelt(n)));
	const usesTrains = trainStops.size > 0 || names.some((n) => n === 'locomotive' || isRail(n));

	const partial = {
		entities: sortCounts(entities),
		modules: sortCounts(modules),
		requiresSpaceAge: spaceAgeEvidence.length > 0,
		planets: [...planets].sort()
	};

	const limits = [
		`game data is ${game.gameVersion} + Space Age; pre-2.0 prints are renamed to 2.0 names and use 2.0 recipes`,
		'rates are nameplate: full input supply, no research productivity; mining drills are not counted',
		'entity sizes and surface conditions come from a regex scan of factorio-data, not a game dump',
		'unknown names are matched to mods by name prefix only'
	];
	if (furnacesWithoutRecipe > 0) limits.push(`${furnacesWithoutRecipe} furnaces store no recipe, so their smelting is not counted`);
	if (unknownNames.length > 0 && !sameVersionAsData)
		limits.push(`print is from ${gameVersion}, so some unknown names may be version changes rather than mods`);

	return {
		analyzerVersion: ANALYZER_VERSION,
		gameDataVersion: game.gameVersion,
		rootKind: nodes[0]?.kind ?? 'blueprint',
		gameVersion,
		gameMajor,
		blueprintCount: prints.length,
		bookCount: nodes.filter((n) => n.kind === 'blueprint_book').length,
		maxDepth,
		entityCount: prints.reduce((s, n) => s + n.entityCount, 0),
		tileCount: prints.reduce((s, n) => s + n.tileCount, 0),
		...partial,
		recipes: sortCounts(recipes),
		tiles: sortCounts(tiles),
		qualities,
		beacons: entities['beacon'] ?? 0,
		wires,
		combinators,
		signs,
		trainStops: [...trainStops].sort(),
		belts,
		spaceAgeEvidence,
		usesQuality: Object.keys(qualities).length > 0,
		// Unwired constant combinators are signage, not logic.
		usesCircuits: wires.red + wires.green > 0,
		usesTrains,
		usesElevatedRails: names.some((n) => n.startsWith('elevated-') || n === 'rail-ramp'),
		placeableOn,
		surfaceEvidence: surfaceEvidence.sort(),
		mods: [...mods].sort(),
		unknownNames,
		labels: nodes.map((n) => n.label).filter((l): l is string => !!l),
		outputs: [...outputs].sort(),
		// An item one page makes and another consumes is internal to the book, not an input.
		inputs: [...inputs].filter((i) => !outputs.has(i) && !products.has(i)).sort(),
		products: [...products].sort(),
		rates: sortCounts(rates),
		claimedVersions: claimedVersions(...nodes.map((n) => n.label)),
		claimedPlanets: claimedPlanets(...nodes.flatMap((n) => [n.label, n.description])),
		stageGuess: stageGuess(partial),
		role: (Object.keys(sortCounts(roles))[0] as Role | undefined) ?? 'empty',
		roles: sortCounts(roles),
		byCategory: Object.fromEntries(Object.entries(byCategory).map(([c, counts]) => [c, sortCounts(counts)])),
		beltThroughput,
		limits,
		nodes
	};
};
