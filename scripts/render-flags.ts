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
 *
 * Prod is reached through the backfill's remote bindings (scripts/backfill/stage.ts), so it needs
 * `wrangler login` and Node on PATH, and the stage must be deployed with migration 0015.
 */
import { planSize, syncRenderFlags } from '#lib/server/pipeline/render-flags.js';
import { diskPages, localD1File, mergePages, readUploads, RENDERS_DIR, uploadedPages } from './render/flags';
import { confirmProd, fail, n, openStage, parseStageArgs, runOn } from './stage-command';

const USAGE = 'usage: bun run render:flags --stage local|prod [--db N] [--dry-run] [--yes]';

const { flags, stage, generation } = parseStageArgs(USAGE, {});

// What should be flagged, from the local D1 (and the renders folder, RENDERS_DIR, for local).
const file = localD1File() ?? fail('no local D1 database (.wrangler/state): run `bun run db:migrate`, and render with --upload first');
const { jobs, uploads } = (() => {
	try {
		return readUploads(file, stage);
	} catch (e) {
		return fail(`✗ ${e instanceof Error ? e.message : String(e)}`);
	}
})();
const uploaded = uploadedPages(jobs, uploads);
const disk = stage === 'local' ? await diskPages() : new Map<string, number>();
const wanted = mergePages(uploaded, disk);
console.log(
	`${n(wanted.size)} prints have a render for ${stage}: ${n(uploaded.size)} uploaded to its bucket` +
		(stage === 'local' ? `, ${n(disk.size)} in ${RENDERS_DIR}` : '')
);

// openTarget checks the stage has print_renders (migration 0015).
const target = await openStage(stage, generation);
const db = target.env.DB;
await runOn(target, async () => {
	const preview = await syncRenderFlags(db, wanted, { dryRun: true });
	const p = preview.plan;
	console.log(
		`${target.database}: ${n(p.upsert.length)} rows to set, ${n(p.remove.length)} to unset; ` +
			`search tokens: ${n(p.tag.length)} to add, ${n(p.untag.length)} to remove ` +
			`(${n(preview.searchable)} of the ${n(preview.flagged)} flagged prints are ingested here)`
	);
	if (planSize(p) === 0) console.log('already in sync; nothing written');
	else if (flags['dry-run']) console.log('dry run; nothing written');
	else {
		await confirmProd(stage, flags.yes, 'Write these to PROD?');
		const done = await syncRenderFlags(db, wanted, {
			onBatch: (i, total) => process.stdout.write(`\r  ${n(i)}/${n(total)} statements`)
		});
		process.stdout.write('\n');
		console.log(`✓ ${n(done.flagged)} prints flagged (${n(done.searchable)} searchable); ${n(done.rowsWritten)} D1 rows written`);
	}
});
