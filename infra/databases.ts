/**
 * Deployed stages and their D1 generations, shared by alchemy.run.ts (what to create and bind) and
 * the backfill (scripts/backfill/stage.ts: which database to write to). No imports, so the backfill
 * can read it without loading Alchemy.
 */

export const PREFIX = 'factorio-prints';
/** Deployed stages. Only prod; add a name here (and its DATABASES entry) for a staging environment. */
export const STAGES = ['prod'] as const;
export type Stage = (typeof STAGES)[number];

/** The one sprites bucket (game icons; sprite atlases later). Prod owns it; any other stage links to it. */
export const SPRITES_BUCKET = `${PREFIX}-sprites`;

/**
 * D1 generations per stage. `bound` is the database the Worker uses as DB. `importTarget`, when
 * set, is an extra database that Alchemy creates and migrates but doesn't bind: the backfill is
 * imported into it, then it becomes `bound` (docs/deploy.md, "Swapping in a fresh D1 database").
 * Keep this in code, not in env vars, so every machine and CI deploy binds the same database.
 */
export const DATABASES: Record<Stage, { bound: number; importTarget?: number }> = {
	prod: { bound: 1 }
};
