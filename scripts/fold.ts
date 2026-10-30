/**
 * `bun run fold --stage local|prod [--all] [--dry-run]`: rebuild the soft fold (src/lib/server/pipeline/fold.ts)
 * from scratch: every group of live prints with the same whole content (≥ 50 entities + tiles), every
 * later copy, whoever posted it, folded into the group's earliest print (`duplicate_of`). Writes only what
 * differs: the changed prints' R2 documents first, then their D1 rows, then the facet counts (which leave
 * folded prints out) and one page-cache bump; a second run writes nothing. A backfill does the same at the
 * end of every run, and refolds everything when FOLD_VERSION changed; this is for a run cut short, a rule
 * change, or a check.
 *
 *   --stage S     local = the miniflare state `bun run dev` uses; prod = the deployed stage
 *   --all         also compare the document of every print in a group, changed or not, and fix any
 *                 that disagrees with its row (a document written by an older build)
 *   --db N        D1 generation for prod (default: DATABASES.<stage>.bound in infra/databases.ts)
 *   --dry-run     show what would change, write nothing
 *   --yes         don't ask before writing to prod
 *
 * Prod is reached through the backfill's remote bindings (scripts/backfill/stage.ts): `wrangler login`, Node on PATH.
 */
import { Effect, Layer } from 'effect';
import { bumpPageVersion } from '#lib/server/page-cache.js';
import { clearFoldDirty, isFoldDirty } from '#lib/server/pipeline/fold.js';
import { refoldAll } from '#lib/server/pipeline/pipeline.js';
import { RawStoreR2 } from '#lib/server/pipeline/raw-store.js';
import { PrintRepository, PrintRepositoryD1 } from '#lib/server/pipeline/repository.js';
import { confirmProd, n, openStage, parseStageArgs, requireSchema, runOn } from './stage-command';

const USAGE = 'usage: bun run fold --stage local|prod [--all] [--db N] [--dry-run] [--yes]';

const { flags, stage, generation } = parseStageArgs(USAGE, { all: { type: 'boolean', default: false } });
const target = await openStage(stage, generation);
const { DB: db, RAW: raw } = target.env;
const layer = Layer.mergeAll(PrintRepositoryD1(db), RawStoreR2(raw));
const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

await runOn(target, async () => {
	await requireSchema(db, stage, 'SELECT duplicate_of, identical_to FROM prints LIMIT 0', 'prints.duplicate_of', '0022');
	const dirty = await isFoldDirty(db);
	if (dirty) console.log('the folds need recomputing (a backfill was quit or its refold failed, or the fold rule changed)');
	const { members: preview } = await run(Effect.provide(refoldAll({ bump: false, dryRun: true }), layer));
	const changed = preview.filter((m) => m.changed);
	const folded = preview.filter((m) => m.duplicateOf).length;
	console.log(
		`${target.database}: ${n(preview.length)} prints in groups or pointing anywhere; should be ${n(folded)} folded; ` +
			`${n(changed.length)} rows to change (${n(changed.filter((m) => m.duplicateOf).length)} to fold, ${n(changed.filter((m) => !m.duplicateOf).length)} to unfold or clear)`
	);
	for (const m of changed.slice(0, 20)) {
		console.log(`  ${m.printId} → ${m.duplicateOf ? `folded into ${m.duplicateOf}` : 'on its own'}`);
	}
	if (changed.length > 20) console.log(`  … and ${n(changed.length - 20)} more`);
	if (flags['dry-run']) return console.log('dry run; nothing written');
	if (!changed.length && !flags.all) {
		if (dirty) await clearFoldDirty(db);
		return console.log('already in sync; nothing written');
	}
	await confirmProd(stage, flags.yes, 'Write these to PROD?');
	const { documents } = await run(Effect.provide(refoldAll({ bump: true, recheck: flags.all }), layer));
	// Folded prints count in no facet (the unfiltered sidebar); rebuilding bumps the page cache again, harmlessly.
	if (changed.length)
		await run(
			Effect.provide(
				Effect.gen(function* () {
					yield* (yield* PrintRepository).rebuildFacets();
				}),
				layer
			)
		);
	// Only once the counts are right: a run that fails before leaves the folds dirty, so the next one finishes it.
	await clearFoldDirty(db);
	// Documents put right with no row to change still need the cached pages gone.
	if (documents && !changed.length) await db.batch([bumpPageVersion(db)]);
	console.log(
		`✓ ${n(changed.length)} rows changed, ${n(documents)} documents written${changed.length ? ', facet counts rebuilt' : ''}${changed.length || documents ? ', page cache bumped' : ''}`
	);
});
