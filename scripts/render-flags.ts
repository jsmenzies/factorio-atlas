/**
 * `bun run render:flags --stage local|prod`: tell a stage's D1 which prints have a game render, for
 * the search page's "Only prints with a render" filter (`?render=1`).
 *
 * Reads what this machine's render runs uploaded to that stage's RENDERS bucket (render_uploads
 * and render_jobs in the local D1, read-only; for `local` also <renders dir>/<id>/index.json, which
 * the dev site reads first), then brings the stage's `print_renders` table and the `render_yes`
 * facet token of each print's search row in line with it: rows and tokens are set and unset, and
 * only what differs is written, in batches. Idempotent: run it again after any upload run.
 *
 *   --stage S     local = the miniflare state `bun run dev` uses; prod = the deployed stage
 *   --db N        D1 generation for prod (default: DATABASES.<stage>.bound in infra/databases.ts)
 *   --dry-run     show what would change, write nothing
 *   --yes         don't ask before writing to prod
 *   --bump        bump the stage's page cache even when no row changes (what an upload run's
 *                 `--flags` step does after replacing or removing files; the command it prints
 *                 when that step fails)
 *
 * The work is scripts/render/stage-flags.ts, shared with the `--flags` step of `bun run render
 * --upload` and `bun run render:thumbs --upload`. It also sets each flagged print's search-card thumbnail (print_renders' cover columns, migration
 * 0018): the first page of the thumbs.json uploaded to that bucket by `render:thumbs --upload`
 * (thumb_uploads in the local D1; for `local` the thumbs folder, THUMBS_DIR, first).
 *
 * Prod is reached through the backfill's remote bindings (scripts/backfill/stage.ts), so it needs
 * `wrangler login` and Node on PATH, and the stage must be deployed with migration 0018.
 */
import { runStageFlags } from './render/stage-flags';
import { confirmProd, fail, parseStageArgs } from './stage-command';

const USAGE = 'usage: bun run render:flags --stage local|prod [--db N] [--dry-run] [--yes] [--bump]';

const { flags, stage, generation } = parseStageArgs(USAGE, { bump: { type: 'boolean', default: false } });

try {
	await runStageFlags(stage, {
		generation,
		dryRun: flags['dry-run'],
		confirm: (question) => confirmProd(stage, flags.yes, question),
		bump: flags.bump,
		log: (line) => console.log(line)
	});
	process.exit(0);
} catch (e) {
	fail(`✗ ${e instanceof Error ? e.message : String(e)}`);
}
