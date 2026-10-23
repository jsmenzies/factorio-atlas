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

/** A stage's bucket of copied Imgur screenshots (`bun run screenshots --upload`). */
export const screenshotsBucket = (stage: Stage) => `${PREFIX}-${stage}-screenshots`;

/**
 * A stage's Analytics Engine dataset of print page views (VIEWS binding; src/routes/prints/[id]/view).
 * Cloudflare creates it on the first write. `bun run views:sync` reads it by this name, as an SQL
 * table, hence underscores.
 */
export const viewsDataset = (stage: Stage) => `${PREFIX.replaceAll('-', '_')}_${stage}_views`;

/**
 * D1 generations per stage. `bound` is the database the Worker uses as DB. `importTarget`, when
 * set, is an extra database that Alchemy creates and migrates but doesn't bind: the backfill is
 * imported into it, then it becomes `bound` (docs/deploy.md, "Swapping in a fresh D1 database").
 * Keep this in code, not in env vars, so every machine and CI deploy binds the same database.
 */
export const DATABASES: Record<Stage, { bound: number; importTarget?: number }> = {
	prod: { bound: 1 }
};
