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
import { parseArgs } from 'node:util';
import { planSize, syncRenderFlags } from '#lib/server/pipeline/render-flags.js';
import { openTarget, STAGES, TargetError, type Stage } from './backfill/stage';
import { Terminal } from './backfill/terminal';
import { diskPages, localD1File, mergePages, readUploads, RENDERS_DIR, uploadedPages } from './render/flags';

const USAGE = 'usage: bun run render:flags --stage local|prod [--db N] [--dry-run] [--yes]';

const fail = (message: string): never => {
	console.error(message);
	process.exit(2);
};

const { values: flags } = (() => {
	try {
		return parseArgs({
			options: {
				stage: { type: 'string' },
				db: { type: 'string' },
				'dry-run': { type: 'boolean', default: false },
				yes: { type: 'boolean', default: false },
				help: { type: 'boolean', short: 'h', default: false }
			},
			strict: true
		});
	} catch (e) {
		return fail(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
	}
})();
if (flags.help) {
	console.log(USAGE);
	process.exit(0);
}
const stage = flags.stage as Stage;
if (!STAGES.includes(stage)) fail(`--stage ${STAGES.join('|')} is required\n${USAGE}`);
const generation = flags.db === undefined ? undefined : Number(flags.db);
if (generation !== undefined && !(Number.isInteger(generation) && generation > 0)) fail('--db must be a positive integer');
const n = (x: number) => x.toLocaleString('en-US');

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
const target = await openTarget(stage, { generation }).catch((e: unknown) =>
	fail(e instanceof TargetError || e instanceof Error ? `✗ ${e.message}` : String(e))
);
const db = target.env.DB;
try {
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
		if (stage === 'prod' && !flags.yes) {
			const term = new Terminal();
			if (!term.tty) throw new TargetError('refusing to write to prod without a terminal to confirm in: pass --yes');
			if ((await term.ask('Write these to PROD? Type "prod" to continue: ')) !== 'prod')
				throw new TargetError('not confirmed; nothing written');
		}
		const done = await syncRenderFlags(db, wanted, {
			onBatch: (i, total) => process.stdout.write(`\r  ${n(i)}/${n(total)} statements`)
		});
		process.stdout.write('\n');
		console.log(`✓ ${n(done.flagged)} prints flagged (${n(done.searchable)} searchable); ${n(done.rowsWritten)} D1 rows written`);
	}
} catch (e) {
	await target.dispose();
	fail(`✗ ${e instanceof Error ? e.message : String(e)}`);
}
await target.dispose();
process.exit(0);
