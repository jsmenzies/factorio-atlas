/**
 * Decoded exchange-string JSON → compact per-page payload for the viewer. Pure; the
 * prototype lookups come in through a `Catalog` so this module carries no game data.
 */
import { decodeGameVersion } from '#lib/server/pipeline/decode.js';
import { normalizeDirection } from './geometry.js';
import type { Category, CompactEntity, CompactPage, CompactTiles, CompactWire, EntityExtra, Kind, NameInfo, PageRef } from './types.js';

type Json = Record<string, unknown>;
type Version = [number, number, number, number];

export interface ProtoInfo {
	/** Prototype name after 1.x → 2.0 renames. */
	proto: string;
	type: string | null;
	size: [number, number];
}

export interface Catalog {
	/** Look up an entity; `major` < 2 applies the 1.x → 2.0 renames first. Null when unknown. */
	entity: (name: string, major: number) => ProtoInfo | null;
	/** Whether a recipe has a fluid ingredient or product. */
	recipeUsesFluid: (recipe: string, major: number) => boolean;
}

const asArray = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const KINDS = ['blueprint', 'blueprint_book', 'upgrade_planner', 'deconstruction_planner'] as const;
const MAX_DEPTH = 32;

const CATEGORY_BY_TYPE: Record<string, Category> = {};
const assign = (cat: Category, types: string) => types.split(' ').forEach((t) => (CATEGORY_BY_TYPE[t] = cat));
assign('belts', 'transport-belt underground-belt splitter loader loader-1x1 linked-belt lane-splitter');
assign('inserters', 'inserter');
assign('production', 'assembling-machine furnace mining-drill lab rocket-silo beacon agricultural-tower asteroid-collector');
assign(
	'power',
	'electric-pole solar-panel accumulator boiler generator reactor heat-pipe heat-interface burner-generator fusion-reactor fusion-generator power-switch lightning-attractor electric-energy-interface'
);
assign(
	'logistics',
	'container logistic-container linked-container proxy-container infinity-container storage-tank pipe pipe-to-ground infinity-pipe pump offshore-pump valve roboport cargo-bay space-platform-hub cargo-landing-pad thruster'
);
assign(
	'circuits',
	'arithmetic-combinator decider-combinator constant-combinator selector-combinator programmable-speaker lamp display-panel'
);
assign(
	'rail',
	'straight-rail curved-rail-a curved-rail-b half-diagonal-rail legacy-straight-rail legacy-curved-rail elevated-straight-rail elevated-curved-rail-a elevated-curved-rail-b elevated-half-diagonal-rail rail-ramp rail-support rail-signal rail-chain-signal train-stop locomotive cargo-wagon fluid-wagon artillery-wagon'
);
assign('defence', 'turret ammo-turret electric-turret fluid-turret artillery-turret wall gate land-mine radar');

export const categoryOf = (type: string | null): Category => (type ? (CATEGORY_BY_TYPE[type] ?? 'other') : 'unknown');

const KIND_BY_TYPE: Record<string, Kind> = {
	'transport-belt': 'belt',
	'underground-belt': 'underground',
	'linked-belt': 'underground',
	splitter: 'splitter',
	'lane-splitter': 'splitter',
	loader: 'loader',
	'loader-1x1': 'loader',
	inserter: 'inserter',
	pipe: 'pipe',
	'infinity-pipe': 'pipe',
	'pipe-to-ground': 'pipe-to-ground',
	'straight-rail': 'rail-straight',
	'elevated-straight-rail': 'rail-straight',
	'half-diagonal-rail': 'rail-half-diagonal',
	'elevated-half-diagonal-rail': 'rail-half-diagonal',
	'curved-rail-a': 'rail-curve-a',
	'elevated-curved-rail-a': 'rail-curve-a',
	'curved-rail-b': 'rail-curve-b',
	'elevated-curved-rail-b': 'rail-curve-b',
	'legacy-straight-rail': 'rail-legacy-straight',
	'legacy-curved-rail': 'rail-legacy-curve',
	'rail-signal': 'signal',
	'rail-chain-signal': 'signal',
	'train-stop': 'train-stop',
	locomotive: 'vehicle',
	'cargo-wagon': 'vehicle',
	'fluid-wagon': 'vehicle',
	'artillery-wagon': 'vehicle'
};

/** Modded names we can't look up still draw sensibly when they follow vanilla naming. */
const kindFromName = (name: string): Kind => {
	if (name.endsWith('pipe-to-ground')) return 'pipe-to-ground';
	if (/(^|-)pipe$/.test(name)) return 'pipe';
	if (name.endsWith('underground-belt')) return 'underground';
	if (name.endsWith('transport-belt')) return 'belt';
	if (name.endsWith('splitter')) return 'splitter';
	if (name.endsWith('inserter')) return 'inserter';
	if (name.endsWith('loader')) return 'loader';
	return 'box';
};

const ROLLING_STOCK_SIZE: [number, number] = [2, 6];

const versionString = (v: Version | null) => (v ? `${v[0]}.${v[1]}.${v[2]}` : null);

/** Walk a decoded payload the same way analyze.ts does, so paths match `print_nodes.path`. */
function* walkNodes(
	obj: Json,
	path: number[],
	inherited: Version | null
): Generator<{ path: string; kind: PageRef['kind']; body: Json; version: Version | null; depth: number }> {
	if (path.length > MAX_DEPTH) return;
	const kind = KINDS.find((k) => k in obj);
	if (!kind) return;
	const body = (obj[kind] ?? {}) as Json;
	const version = decodeGameVersion(body.version) ?? inherited;
	yield { path: path.join('/'), kind, body, version, depth: path.length };
	if (kind === 'blueprint_book') {
		for (const child of asArray(body.blueprints)) {
			const idx = typeof child.index === 'number' ? child.index : 0;
			yield* walkNodes(child, [...path, idx], version);
		}
	}
}

/** One node's own JSON (`{label, entities, ...}`) and kind, by book path; null when there's no such node. */
export const nodeAt = (decoded: unknown, path: string): { kind: PageRef['kind']; body: Json } | null => {
	const n = [...walkNodes((decoded ?? {}) as Json, [], null)].find((x) => x.path === path);
	return n ? { kind: n.kind, body: n.body } : null;
};

/** Every node in the payload, books included, in book order. */
export const listPages = (decoded: unknown): PageRef[] =>
	[...walkNodes((decoded ?? {}) as Json, [], null)].map((n) => ({
		path: n.path,
		kind: n.kind,
		label: str(n.body.label) ?? null,
		depth: n.depth,
		entities: n.kind === 'blueprint' ? asArray(n.body.entities).length : 0
	}));

/** 1.x per-entity circuit ids hold `{red: [...], green: [...]}`; `Cu0`/`Cu1` hold copper. */
const legacyConnections = (e: Json): { id: number; colour: 0 | 1 | 2 }[] => {
	const out: { id: number; colour: 0 | 1 | 2 }[] = [];
	const conns = e.connections;
	if (conns && typeof conns === 'object') {
		for (const c of Object.values(conns as Json)) {
			if (Array.isArray(c)) {
				for (const t of c as Json[]) if (typeof t.entity_id === 'number') out.push({ id: t.entity_id, colour: 2 });
			} else if (c && typeof c === 'object') {
				for (const [colour, key] of [
					[0, 'red'],
					[1, 'green']
				] as const) {
					for (const t of asArray((c as Json)[key])) if (typeof t.entity_id === 'number') out.push({ id: t.entity_id, colour });
				}
			}
		}
	}
	for (const n of Array.isArray(e.neighbours) ? e.neighbours : []) if (typeof n === 'number') out.push({ id: n, colour: 2 });
	return out;
};

const moduleStrings = (items: unknown): string[] => {
	const counts = new Map<string, number>();
	if (Array.isArray(items)) {
		for (const plan of items as Json[]) {
			const id = (plan.id ?? {}) as Json;
			const name = str(id.name);
			if (!name) continue;
			const q = str(id.quality);
			const inv = asArray(((plan.items ?? {}) as Json).in_inventory);
			const count = inv.reduce((s, p) => s + (num(p.count) ?? 1), 0) || 1;
			const key = q && q !== 'normal' ? `${name} (${q})` : name;
			counts.set(key, (counts.get(key) ?? 0) + count);
		}
	} else if (items && typeof items === 'object') {
		for (const [name, n] of Object.entries(items as Json)) if (typeof n === 'number') counts.set(name, n);
	}
	return [...counts].map(([k, n]) => `${k} ×${n}`);
};

const vec = (v: unknown): [number, number] | undefined => {
	const o = v as { x?: unknown; y?: unknown } | undefined;
	const x = num(o?.x);
	const y = num(o?.y);
	return x !== undefined && y !== undefined ? [x, y] : undefined;
};

const filterNames = (e: Json): string[] | undefined => {
	const names = asArray(e.filters)
		.map((f) => str(f.name) ?? str((f.signal as Json | undefined)?.name))
		.filter((n): n is string => !!n);
	return names.length ? names.slice(0, 5) : undefined;
};

/** Group tiles by name into horizontal runs. */
const tileRuns = (tiles: Json[], rename: (n: string) => string): CompactTiles[] => {
	const byName = new Map<string, [number, number][]>();
	for (const t of tiles) {
		const p = vec(t.position);
		const name = str(t.name);
		if (!p || !name) continue;
		const key = rename(name);
		let list = byName.get(key);
		if (!list) byName.set(key, (list = []));
		list.push([Math.floor(p[0]), Math.floor(p[1])]);
	}
	return [...byName].map(([name, cells]) => {
		cells.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
		const runs: number[] = [];
		for (const [x, y] of cells) {
			const n = runs.length;
			if (n && runs[n - 2] === y && runs[n - 3] + runs[n - 1] === x) runs[n - 1]++;
			else if (!(n && runs[n - 2] === y && x < runs[n - 3] + runs[n - 1])) runs.push(x, y, 1);
		}
		return { name, runs };
	});
};

/**
 * Pre-1.0 exports (0.15 to 0.18 here) put entity positions half a tile off: a 1×1 belt sits
 * at (0, -1) instead of (0.5, -0.5), a 5×5 refinery at whole numbers. Vote with every known
 * footprint, per axis, and shift so centres of odd-sized entities land on .5. Returns the
 * shift applied, so game renders can be moved the same way.
 */
export const alignToGrid = (entities: CompactEntity[], names: NameInfo[]): [number, number] => {
	const votes = [0, 0];
	const frac = (v: number) => Math.abs(v - Math.floor(v));
	for (const [n, x, y, d] of entities) {
		const info = names[n];
		if (!info.known || info.kind.startsWith('rail-') || info.kind === 'vehicle' || d % 4 !== 0) continue;
		const [w, h] = d === 4 || d === 12 ? [info.h, info.w] : [info.w, info.h];
		const off = (size: number, v: number) => (Math.abs(frac(v) - (size % 2 ? 0.5 : 0)) > 0.25 ? 1 : -1);
		votes[0] += off(w, x);
		votes[1] += off(h, y);
	}
	const [sx, sy] = votes.map((v) => (v > 0 ? 0.5 : 0));
	if (!sx && !sy) return [0, 0];
	for (const row of entities) {
		row[1] += sx;
		row[2] += sy;
	}
	return [sx, sy];
};

/** The compact page at `path`, or null when it isn't a blueprint. */
export const extractPage = (decoded: unknown, path: string, catalog: Catalog): CompactPage | null => {
	const node = [...walkNodes((decoded ?? {}) as Json, [], null)].find((n) => n.path === path);
	if (!node || node.kind !== 'blueprint') return null;
	const bp = node.body;
	const major = node.version?.[0] ?? 2;

	const names: NameInfo[] = [];
	const nameIndex = new Map<string, number>();
	const intern = (name: string): number => {
		const known = nameIndex.get(name);
		if (known !== undefined) return known;
		const p = catalog.entity(name, major);
		const type = p?.type ?? null;
		const kind = (type && KIND_BY_TYPE[type]) || (p ? 'box' : kindFromName(name));
		const [w, h] = kind === 'vehicle' ? ROLLING_STOCK_SIZE : (p?.size ?? [1, 1]);
		names.push({ name, proto: p?.proto ?? name, type, category: categoryOf(type), kind, w, h, known: !!p });
		nameIndex.set(name, names.length - 1);
		return names.length - 1;
	};

	const entities: CompactEntity[] = [];
	const byNumber = new Map<number, number>();
	const legacyWires: { from: number; to: number; colour: 0 | 1 | 2 }[] = [];
	for (const e of asArray(bp.entities)) {
		const name = str(e.name);
		const p = vec(e.position);
		if (!name || !p) continue;
		const n = intern(name);
		const info = names[n];
		const extra: EntityExtra = {};
		const type = str(e.type);
		if (type === 'input' || type === 'output') extra.io = type === 'input' ? 'in' : 'out';
		const recipe = str(e.recipe);
		if (recipe) {
			extra.recipe = recipe;
			if (catalog.recipeUsesFluid(recipe, major)) extra.fluid = 1;
		}
		const q = str(e.quality);
		if (q && q !== 'normal') extra.quality = q;
		const rq = str(e.recipe_quality);
		if (rq && rq !== 'normal') extra.recipeQuality = rq;
		const mods = moduleStrings(e.items).filter((m) => m.includes('module'));
		if (mods.length) extra.modules = mods;
		const pick = vec(e.pickup_position);
		if (pick) extra.pickup = pick;
		const drop = vec(e.drop_position);
		if (drop) extra.drop = drop;
		if (e.mirror === true) extra.mirror = 1;
		const ip = str(e.input_priority);
		if (ip === 'left' || ip === 'right') extra.inPri = ip;
		const op = str(e.output_priority);
		if (op === 'left' || op === 'right') extra.outPri = op;
		const filter = str(e.filter) ?? str((e.filter as Json | undefined)?.name);
		if (filter) extra.filter = filter;
		const text = str(e.station) ?? str(e.text);
		if (text) extra.text = text;
		const orientation = num(e.orientation);
		if (info.kind === 'vehicle' && orientation !== undefined) extra.orientation = orientation;
		if (info.kind === 'inserter') {
			const f = filterNames(e);
			if (f) extra.filters = f;
		}
		const idx = entities.length;
		const row: CompactEntity = [n, p[0], p[1], normalizeDirection(num(e.direction), major)];
		if (Object.keys(extra).length) row.push(extra);
		entities.push(row);
		if (typeof e.entity_number === 'number') {
			byNumber.set(e.entity_number, idx);
			for (const c of legacyConnections(e)) legacyWires.push({ from: e.entity_number, to: c.id, colour: c.colour });
		}
	}

	const [sx, sy] = alignToGrid(entities, names);

	const wires: CompactWire[] = [];
	const seen = new Set<string>();
	const addWire = (a: number | undefined, b: number | undefined, colour: 0 | 1 | 2) => {
		if (a === undefined || b === undefined || a === b) return;
		const key = `${Math.min(a, b)}:${Math.max(a, b)}:${colour}`;
		if (seen.has(key)) return;
		seen.add(key);
		wires.push([a, b, colour]);
	};
	if (Array.isArray(bp.wires)) {
		// 2.0: [entity, connector, entity, connector]; connectors 1/3 red, 2/4 green, 5+ copper.
		for (const w of bp.wires as unknown[]) {
			if (!Array.isArray(w)) continue;
			const id = w[1];
			const colour = id === 1 || id === 3 ? 0 : id === 2 || id === 4 ? 1 : 2;
			addWire(byNumber.get(w[0] as number), byNumber.get(w[2] as number), colour);
		}
	}
	for (const w of legacyWires) addWire(byNumber.get(w.from), byNumber.get(w.to), w.colour);

	return {
		path: node.path,
		label: str(bp.label) ?? null,
		description: str(bp.description) ?? null,
		gameVersion: versionString(node.version),
		sourceDirections: major < 2 ? 8 : 16,
		...(sx || sy ? { offset: [sx, sy] as [number, number] } : {}),
		names,
		entities,
		tiles: tileRuns(asArray(bp.tiles), (n) => n),
		wires
	};
};

/** First blueprint path, for the default page. */
export const firstPagePath = (pages: PageRef[]): string | null => pages.find((p) => p.kind === 'blueprint')?.path ?? null;
