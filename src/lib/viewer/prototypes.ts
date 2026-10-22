/**
 * Prototype facts the viewer's hover tooltips need and `data/game/game-data-*.json` lacks.
 *
 * Source: wube/factorio-data at tags 2.0.55, 1.1.110, 0.17.79 and 0.16.51
 * (base/prototypes/entity/entities.lua, transport-belts.lua, mining-drill.lua and
 * space-age/prototypes/entity/entities.lua). Positions use the 2.0 convention: a fluid
 * connection sits on a tile inside the entity (offset from its centre, north-facing) and
 * points outward, so the neighbour it joins is `position + direction`. The 1.x files list
 * the neighbour tile instead; the geometry is the same for every entity listed here.
 */

/** 16-way directions (2.0 encoding). */
export const N = 0;
export const E = 4;
export const S = 8;
export const W = 12;

/**
 * Underground belt `max_distance`: the output can sit at most this many tiles from the input.
 * Unchanged from 0.16 to 2.0 (5/7/9); turbo is Space Age.
 */
export const UNDERGROUND_MAX: Record<string, number> = {
	'underground-belt': 5,
	'fast-underground-belt': 7,
	'express-underground-belt': 9,
	'turbo-underground-belt': 11
};
export const UNDERGROUND_MAX_DEFAULT = 11;

/** Pipe-to-ground `max_underground_distance` (10 in 0.16, 1.1 and 2.0). */
export const PIPE_TO_GROUND_MAX = 10;

/**
 * Inserter hand positions for a north-facing inserter: pickup at (0, -reach), drop at
 * (0, reach + 0.2). Same in 0.17, 1.1 and 2.0, so `direction` names the pickup side.
 */
export const INSERTER_REACH: Record<string, number> = { 'long-handed-inserter': 2 };

export interface FluidConnection {
	/** Offset of the connecting tile from the entity centre, north-facing. */
	x: number;
	y: number;
	/** Outward direction, north-facing (16-way). */
	dir: number;
	flow: 'in' | 'out' | 'io';
}

export interface FluidSpec {
	connections: FluidConnection[];
	/** Pipes only attach while the recipe uses a fluid (`fluid_boxes_off_when_no_fluid_recipe`). */
	recipeGated?: boolean;
	/** Per-direction positions (N, E, S, W) that override rotation, e.g. the pumpjack's. */
	positions?: [number, number][];
}

const c = (x: number, y: number, dir: number, flow: FluidConnection['flow'] = 'io'): FluidConnection => ({ x, y, dir, flow });

export const FLUID_SPECS: Record<string, FluidSpec> = {
	'storage-tank': { connections: [c(-1, -1, N), c(1, 1, E), c(1, 1, S), c(-1, -1, W)] },
	pump: { connections: [c(0, -0.5, N, 'out'), c(0, 0.5, S, 'in')] },
	'offshore-pump': { connections: [c(0, 0, S, 'out')] },
	boiler: { connections: [c(-1, 0.5, W), c(1, 0.5, E), c(0, -0.5, N, 'out')] },
	'heat-exchanger': { connections: [c(-1, 0.5, W), c(1, 0.5, E), c(0, -0.5, N, 'out')] },
	'steam-engine': { connections: [c(0, 2, S), c(0, -2, N)] },
	'steam-turbine': { connections: [c(0, 2, S), c(0, -2, N)] },
	'chemical-plant': { connections: [c(-1, -1, N, 'in'), c(1, -1, N, 'in'), c(-1, 1, S, 'out'), c(1, 1, S, 'out')] },
	'oil-refinery': {
		connections: [c(-1, 2, S, 'in'), c(1, 2, S, 'in'), c(-2, -2, N, 'out'), c(0, -2, N, 'out'), c(2, -2, N, 'out')]
	},
	'assembling-machine-2': { connections: [c(0, -1, N, 'in'), c(0, 1, S, 'out')], recipeGated: true },
	'assembling-machine-3': { connections: [c(0, -1, N, 'in'), c(0, 1, S, 'out')], recipeGated: true },
	pumpjack: {
		connections: [c(1, -1, N, 'out')],
		positions: [
			[1, -1],
			[1, -1],
			[-1, 1],
			[-1, 1]
		]
	},
	foundry: {
		connections: [c(-1, 2, S, 'in'), c(1, 2, S, 'in'), c(-1, -2, N, 'out'), c(1, -2, N, 'out')],
		recipeGated: true
	},
	'cryogenic-plant': {
		connections: [c(-2, 2, S, 'in'), c(0, 2, S, 'in'), c(2, 2, S, 'in'), c(-2, -2, N, 'out'), c(0, -2, N, 'out'), c(2, -2, N, 'out')],
		recipeGated: true
	},
	biochamber: {
		connections: [c(-1, -1, N, 'in'), c(1, -1, N, 'in'), c(1, 1, S, 'out'), c(-1, 1, S, 'out')],
		recipeGated: true
	},
	'electromagnetic-plant': {
		connections: [c(-1.5, 0.5, W), c(1.5, -0.5, E), c(0.5, 1.5, S), c(-0.5, -1.5, N)],
		recipeGated: true
	},
	'fusion-reactor': {
		connections: [
			c(-2.5, -1.5, W, 'in'),
			c(-2.5, 1.5, W, 'in'),
			c(2.5, -1.5, E, 'in'),
			c(2.5, 1.5, E, 'in'),
			c(-1.5, 2.5, S, 'out'),
			c(1.5, 2.5, S, 'out'),
			c(-1.5, -2.5, N, 'out'),
			c(1.5, -2.5, N, 'out')
		]
	},
	'fusion-generator': {
		connections: [
			c(-1, 2, S, 'in'),
			c(1, 2, S, 'in'),
			c(0, -2, N),
			c(-1, 0, W),
			c(1, 0, E),
			c(-1, -1, W),
			c(1, -1, E),
			c(-1, -2, N, 'out'),
			c(1, -2, N, 'out')
		]
	},
	thruster: { connections: [c(-1.5, -2, W, 'in'), c(1.5, 0, E, 'in'), c(1.5, -2, E, 'in'), c(-1.5, 0, W, 'in')] }
};
