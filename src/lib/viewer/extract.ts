/**
 * Decoded exchange-string JSON → compact per-page payload for the viewer. Pure; the
 * prototype lookups come in through a `Catalog` so this module carries no game data.
 */
import { bookEntryIndex, decodeGameVersion } from '#lib/server/pipeline/decode.js';
import { normalizeDirection } from './geometry.js';
import type { Category, CompactEntity, CompactPage, EntityExtra, Kind, NameInfo, PageRef } from './types.js';

type Json = Record<string, unknown>;
type Version = [number, number, number, number];

export interface ProtoInfo {
	/** Prototype name after renames to the game data's names. */
	proto: string;
	type: string | null;
	size: [number, number];
}

export interface Catalog {
	/** Look up an entity, renamed from the version it was saved in (`[major, minor]`) first. Null when unknown. */
	entity: (name: string, saved: readonly [number, number]) => ProtoInfo | null;
	/** Whether a recipe has a fluid ingredient or product. */
	recipeUsesFluid: (recipe: string, saved: readonly [number, number]) => boolean;
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

interface WalkedNode {
	path: string;
	kind: PageRef['kind'];
	body: Json;
	version: Version | null;
	depth: number;
}

/** Walk a decoded payload the same way analyze.ts does, so paths match the analysis' `nodes[].path`. */
function* walkNodes(obj: Json, path: number[], inherited: Version | null): Generator<WalkedNode> {
	if (path.length > MAX_DEPTH) return;
	const kind = KINDS.find((k) => k in obj);
	if (!kind) return;
	const body = (obj[kind] ?? {}) as Json;
	const version = decodeGameVersion(body.version) ?? inherited;
	yield { path: path.join('/'), kind, body, version, depth: path.length };
	if (kind === 'blueprint_book') {
		for (const [i, child] of asArray(body.blueprints).entries()) yield* walkNodes(child, [...path, bookEntryIndex(child, i)], version);
	}
}

/** The first node at a book path (paths can repeat when a book's `index`es do), walking no further than it. */
const findNode = (decoded: unknown, path: string): WalkedNode | null => {
	for (const n of walkNodes((decoded ?? {}) as Json, [], null)) if (n.path === path) return n;
	return null;
};

/** A node's kind and own JSON (`{label, entities, ...}`). */
export interface NodeBody {
	kind: PageRef['kind'];
	body: Json;
}

/** One node's own JSON and kind, by book path; null when there's no such node. */
export const nodeAt = (decoded: unknown, path: string): NodeBody | null => {
	const n = findNode(decoded, path);
	return n ? { kind: n.kind, body: n.body } : null;
};

const pageRef = (n: WalkedNode): PageRef => ({
	path: n.path,
	kind: n.kind,
	label: str(n.body.label) ?? null,
	depth: n.depth,
	entities: n.kind === 'blueprint' ? asArray(n.body.entities).length : 0
});

/** Every node in the payload, books included, in book order. */
export const listPages = (decoded: unknown): PageRef[] => [...walkNodes((decoded ?? {}) as Json, [], null)].map(pageRef);

/**
 * `listPages`, and `nodeAt` for every path, from one walk: calling `nodeAt` per page walks the
 * whole book each time, which took seconds for books of 2,000 pages.
 */
export const listPagesWithNodes = (decoded: unknown): { pages: PageRef[]; nodes: Map<string, NodeBody> } => {
	const walked = [...walkNodes((decoded ?? {}) as Json, [], null)];
	const nodes = new Map<string, NodeBody>();
	for (const n of walked) if (!nodes.has(n.path)) nodes.set(n.path, { kind: n.kind, body: n.body });
	return { pages: walked.map(pageRef), nodes };
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
	const node = findNode(decoded, path);
	if (!node || node.kind !== 'blueprint') return null;
	const bp = node.body;
	const major = node.version?.[0] ?? 2;
	const saved = [major, node.version?.[1] ?? 0] as const;

	const names: NameInfo[] = [];
	const nameIndex = new Map<string, number>();
	const intern = (name: string): number => {
		const known = nameIndex.get(name);
		if (known !== undefined) return known;
		const p = catalog.entity(name, saved);
		const type = p?.type ?? null;
		const kind = (type && KIND_BY_TYPE[type]) || (p ? 'box' : kindFromName(name));
		const [w, h] = kind === 'vehicle' ? ROLLING_STOCK_SIZE : (p?.size ?? [1, 1]);
		names.push({ name, proto: p?.proto ?? name, type, category: categoryOf(type), kind, w, h, known: !!p });
		nameIndex.set(name, names.length - 1);
		return names.length - 1;
	};

	const entities: CompactEntity[] = [];
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
			if (catalog.recipeUsesFluid(recipe, saved)) extra.fluid = 1;
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
		if (info.kind === 'inserter') {
			const f = filterNames(e);
			if (f) extra.filters = f;
		}
		const row: CompactEntity = [n, p[0], p[1], normalizeDirection(num(e.direction), major)];
		if (Object.keys(extra).length) row.push(extra);
		entities.push(row);
	}

	const [sx, sy] = alignToGrid(entities, names);

	return {
		path: node.path,
		label: str(bp.label) ?? null,
		description: str(bp.description) ?? null,
		gameVersion: versionString(node.version),
		sourceDirections: major < 2 ? 8 : 16,
		...(sx || sy ? { offset: [sx, sy] as [number, number] } : {}),
		names,
		entities
	};
};

/** First blueprint path, for the default page. */
export const firstPagePath = (pages: PageRef[]): string | null => pages.find((p) => p.kind === 'blueprint')?.path ?? null;
