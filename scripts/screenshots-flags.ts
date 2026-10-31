/**
 * `bun run screenshots:flags --stage local|prod`: tell a stage's D1 which screenshots are copied to
 * its SCREENSHOTS bucket, so search cards show them (the `screenshots` table, migration 0019).
 *
 * Reads what `bun run screenshots --upload <stage>` put there (its ledger,
 * `<SCREENSHOTS_DIR>/uploads/<stage>.jsonl`): each image gets a row with its last manifest's state
 * (copied, dead or removed), every image in the stage's `screenshot_removals` is 'removed', and
 * other rows go. Only what differs is written; then the page cache is purged. Idempotent: run it
 * after every upload.
 *
 *   --stage S     local = the miniflare state `bun run dev` uses; prod = the deployed stage
 *   --db N        D1 generation for prod (default: DATABASES.<stage>.bound in infra/databases.ts)
 *   --dry-run     show what would change, write nothing
 *   --yes         don't ask before writing to prod
 *   --json        its result as the last stdout line (FlagsResult: rows written, the summary line)
 *
 * Prod is reached through the backfill's remote bindings (scripts/backfill/stage.ts), so it needs
 * `wrangler login` and Node on PATH, and the stage must be deployed with migration 0019.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { shotPlanSize, syncScreenshotFlags, type ShotRow } from '#lib/server/screenshot-flags.js';
import { screenshotsDir } from './screenshots/args.js';
import { ledgerFile, readLedger } from './screenshots/ledger.js';
import { confirmProd, fail, n, openStage, parseStageArgs, requireSchema, runOn } from './stage-command';

const USAGE = 'usage: bun run screenshots:flags --stage local|prod [--db N] [--dry-run] [--yes] [--json]';

/** `--json`: the result as the last stdout line (the update's screenshots step). */
export interface FlagsResult {
	written: number;
	summary: string;
}

const { flags, stage, generation } = parseStageArgs(USAGE, { json: { type: 'boolean', default: false } });
/** The last line (marked ✓ when it wrote): for people, and with --json in the result too. */
const finish = (summary: string, written?: number) => {
	console.log(written === undefined ? summary : `✓ ${summary}`);
	if (flags.json) console.log(JSON.stringify({ written: written ?? 0, summary } satisfies FlagsResult));
};

const dir = screenshotsDir(join(import.meta.dirname, '..'));
const file = join(dir, ledgerFile(stage));
const text = await readFile(file, 'utf8').catch(() =>
	fail(`no uploads to ${stage} recorded (${file}): run \`bun run screenshots --upload ${stage}\` first`)
);
const { held, bad } = readLedger(text);
if (bad) console.warn(`skipped ${bad} unreadable line(s) in ${file}`);
const wanted = new Map<string, ShotRow>();
for (const [id, h] of held) wanted.set(id, h.manifest);
const count = (state: string) => n([...wanted.values()].filter((r) => r.state === state).length);
console.log(`the ${stage} bucket's manifests: ${count('copied')} copied, ${count('dead')} dead, ${count('removed')} removed`);

const target = await openStage(stage, generation);
const db = target.env.DB;
await runOn(target, async () => {
	await requireSchema(db, stage, 'SELECT image_id FROM screenshots LIMIT 0', 'screenshots table', '0019');
	const preview = await syncScreenshotFlags(db, wanted, { dryRun: true });
	console.log(
		`${target.database}: ${n(preview.plan.upsert.length)} rows to set, ${n(preview.plan.remove.length)} to delete ` +
			`(${n(preview.rows)} rows now; ${n(preview.removed)} images taken down on request, kept 'removed')`
	);
	if (shotPlanSize(preview.plan) === 0) finish('already in sync; nothing written');
	else if (flags['dry-run']) finish('dry run; nothing written');
	else {
		await confirmProd(stage, flags.yes, 'Write these to PROD?');
		const done = await syncScreenshotFlags(db, wanted, {
			onBatch: (i, total) => process.stdout.write(`\r  ${n(i)}/${n(total)} statements`)
		});
		process.stdout.write('\n');
		finish(`${n(done.rowsWritten)} D1 rows written; cached pages purged`, done.rowsWritten);
	}
});
