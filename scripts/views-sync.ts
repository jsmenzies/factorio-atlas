/**
 * `bun run views:sync --stage local|prod`: total each print's page views over the last 30 days from
 * prod's Analytics Engine dataset (src/lib/server/views.ts) and write them into a stage's
 * `prints.views_30d` (migration 0016), which the search page's "Popular" sort reads. Only counts that
 * differ are written, so running it again writes nothing; prints with no views in the window go back
 * to 0. `--stage local` copies prod's counts into the local D1 (the local site records no views).
 *
 *   --stage S     local = the miniflare state `bun run dev` uses; prod = the deployed stage
 *   --db N        D1 generation for prod (default: DATABASES.<stage>.bound in infra/databases.ts)
 *   --dry-run     show what would change, write nothing
 *   --yes         don't ask before writing to prod
 *
 * Needs ANALYTICS_API_TOKEN (in .env): a Cloudflare API token with Account Analytics: Read. The
 * account comes from CLOUDFLARE_ACCOUNT_ID or `wrangler whoami`. Prod is reached through the
 * backfill's remote bindings (scripts/backfill/stage.ts), so it needs `wrangler login` and Node on PATH.
 */
import { fetchViews, syncViews, VIEW_DAYS } from '#lib/server/views.js';
import { viewsDataset } from '../infra/databases';
import { accountId } from './backfill/stage';
import { confirmProd, fail, n, openStage, parseStageArgs, requireSchema, runOn } from './stage-command';

const USAGE = 'usage: bun run views:sync --stage local|prod [--db N] [--dry-run] [--yes]';

const { flags, stage, generation } = parseStageArgs(USAGE, {});
const token =
	process.env.ANALYTICS_API_TOKEN?.trim() ||
	fail('ANALYTICS_API_TOKEN is not set: a Cloudflare API token with Account Analytics: Read (docs/deploy.md, "Page views")');

// Views always come from prod: it's the only stage with visitors.
const dataset = viewsDataset('prod');
const wanted = await fetchViews({ accountId: accountId(), token, dataset }).catch((e: unknown) =>
	fail(`✗ ${e instanceof Error ? e.message : String(e)}`)
);
const total = [...wanted.values()].reduce((a, b) => a + b, 0);
console.log(`${dataset}: ${n(total)} views of ${n(wanted.size)} prints in the last ${VIEW_DAYS} days`);

const target = await openStage(stage, generation);
const db = target.env.DB;
await runOn(target, async () => {
	await requireSchema(db, stage, 'SELECT views_30d FROM prints LIMIT 0', 'prints.views_30d', '0016');
	const preview = await syncViews(db, wanted, { dryRun: true });
	const p = preview.plan;
	console.log(
		`${target.database}: ${n(p.set.length)} counts to set, ${n(p.clear.length)} to clear ` +
			`(${n(preview.known)} of the ${n(wanted.size)} viewed prints are ingested here)`
	);
	if (p.set.length + p.clear.length === 0) console.log('already in sync; nothing written');
	else if (flags['dry-run']) console.log('dry run; nothing written');
	else {
		await confirmProd(stage, flags.yes, 'Write these to PROD?');
		const done = await syncViews(db, wanted, {
			onBatch: (i, all) => process.stdout.write(`\r  ${n(i)}/${n(all)} statements`)
		});
		process.stdout.write('\n');
		console.log(`✓ ${n(done.rowsWritten)} D1 rows written`);
	}
});
