/**
 * Compact per-page payload the server sends the blueprint viewer. Decoded blueprints can
 * be megabytes; this keeps only what the hover tooltips over a game render show.
 */

/** Colour group for boxes, from the prototype type. `unknown` means a modded or renamed name. */
export type Category = 'belts' | 'inserters' | 'production' | 'power' | 'logistics' | 'circuits' | 'rail' | 'defence' | 'other' | 'unknown';

/** How the tooltip geometry treats an entity (belt curves, underground pairs, pipes, rails). */
export type Kind =
	| 'belt'
	| 'underground'
	| 'splitter'
	| 'loader'
	| 'inserter'
	| 'pipe'
	| 'pipe-to-ground'
	| 'rail-straight'
	| 'rail-half-diagonal'
	| 'rail-curve-a'
	| 'rail-curve-b'
	| 'rail-legacy-straight'
	| 'rail-legacy-curve'
	| 'signal'
	| 'train-stop'
	| 'vehicle'
	| 'box';

export interface NameInfo {
	/** As written in the blueprint. */
	name: string;
	/** 2.0 prototype name the size and category came from (differs for renamed 1.x names). */
	proto: string;
	/** Prototype type, e.g. `assembling-machine`; null when unknown. */
	type: string | null;
	category: Category;
	kind: Kind;
	/** Footprint in tiles, north-facing. */
	w: number;
	h: number;
	known: boolean;
}

/** Extra fields, only present when set. */
export interface EntityExtra {
	/** Underground belt / loader end: input or output. */
	io?: 'in' | 'out';
	recipe?: string;
	/** Recipe uses a fluid, so recipe-gated fluid boxes are live. */
	fluid?: 1;
	quality?: string;
	recipeQuality?: string;
	/** e.g. ["speed-module-3 ×4"] */
	modules?: string[];
	/** Inserter overrides, relative to the entity centre (2.0 `pickup_position` / `drop_position`). */
	pickup?: [number, number];
	drop?: [number, number];
	mirror?: 1;
	/** Splitter priorities and filter. */
	inPri?: 'left' | 'right';
	outPri?: 'left' | 'right';
	filter?: string;
	/** Train stop name, display panel or other text. */
	text?: string;
	/** Entity filter list (inserters), shortened. */
	filters?: string[];
}

/** [name index, x, y, direction (16-way, normalised), extra?] */
export type CompactEntity = [number, number, number, number, EntityExtra?];

/** What the hover tooltip needs beyond the page itself, resolved on the server for the names the page uses. */
export interface TooltipData {
	icons: import('#lib/icons.js').IconSet;
	/** Prototype name → English name, where the game has one. */
	labels: Record<string, string>;
	/** Entity name (as in the blueprint) → module slots, for entities that have any. */
	slots: Record<string, number>;
}

export interface PageRef {
	/** Book path, matches the analysis' `nodes[].path` (e.g. "", "3", "3/1"). */
	path: string;
	kind: 'blueprint' | 'blueprint_book' | 'upgrade_planner' | 'deconstruction_planner';
	label: string | null;
	depth: number;
	entities: number;
}

export interface CompactPage {
	path: string;
	label: string | null;
	description: string | null;
	/** "2.0.55" etc., inherited from the book when the page has none. */
	gameVersion: string | null;
	/** Direction encoding of the source: 8 (pre-2.0) or 16. Entities are already in 16-way. */
	sourceDirections: 8 | 16;
	/** Shift `alignToGrid` added to every source position; absent when none. */
	offset?: [number, number];
	names: NameInfo[];
	entities: CompactEntity[];
}
