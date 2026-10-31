/**
 * `bun run removals --stage local|prod [--dry-run] [--yes] [--json]`: bring this machine in line with the
 * prints a stage has deleted (approved removals, and prints deleted as gone: `print_tombstones`, migration
 * 0021). The site Worker already deleted the stage's own copies (src/lib/server/takedown.ts); this does
 * the rest. The one-click update runs it first, before pulling the mirror, so every later step sees the
 * blocks.
 *
 * With `--stage prod`:
 * 1. the local D1's `removal_blocks` become prod's (added and dropped), which the backfill's listing, the
 *    render runs, render:top, render:thumbs --upload and render:flags read, so no removed print is
 *    ingested, drawn, uploaded or flagged again;
 * 2. per deleted print: its render-queue and upload rows in the local D1 (every target), its folders in
 *    the renders and thumbnails dirs, and its record (archived in data/raw, or another site's in the
 *    record store, scripts/records/store.ts);
 * 3. per deleted print not swept before (`removal_sweeps` in the local D1): its files in prod's RENDERS
 *    bucket again, through R2's S3 API (normally none: a render upload that was running when the removal
 *    was approved may have put some back);
 * 4. per `image` block not yet marked: the screenshot marked removed in the run state (never fetched or
 *    uploaded again), its files deleted from prod's SCREENSHOTS bucket (through the upload ledger) and
 *    from disk.
 * Steps 2 and 4 look at every deleted print each time (local reads only), step 3 only at new ones, so a
 * run with nothing new says "✓ nothing to do".
 *
 * With `--stage local` (tests): only the local D1's upload rows for the local bucket; nothing on disk,
 * which holds prod's renders.
 *
 * Refuses while a render run is live (it holds the queue; a crashed run's row doesn't count). The first
 * SIGINT or SIGTERM stops it between prints, the second at once. Exit 0 when done, 2 on any error or
 * when stopped (130 on the second signal); the last line starts with ✓ or ✗ (the one-click update's step
 * summary). With `--json` every line goes to stderr and the last stdout line is the result as JSON
 * (`RemovalsResult`), whatever the outcome.
 *
 *   --dry-run   say what would change, change nothing
 *   --yes       don't ask before writing to prod
 *   --json      the result as JSON on stdout (for the one-click update)
 */
import { appendFileSync, existsSync, writeSync } from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RunState } from '#lib/server/pipeline/runs.js';
import { rendersDir, thumbsDir } from '#lib/server/renders-dir.js';
import { insertBlocks, loadBlocks } from '#lib/server/removal-blocks.js';
import { recordsDir } from './records/store.js';
import { openStore } from './render/target.js';
import {
	blockChanges,
	imageBlocks,
	LOCAL_PRINT_TABLES,
	liveRun,
	printPaths,
	unswept,
	type Sweep,
	type Tombstone
} from './removals/plan.js';
import { screenshotsDir } from './screenshots/args.js';
import { formatLine, ledgerFile, readLedger, type LedgerLine } from './screenshots/ledger.js';
import { SIZES_DIR } from './screenshots/make.js';
import { formatEntry, parseState, STATE_FILE, type StateEntry } from './screenshots/state.js';
import { openShotStore } from './screenshots/store.js';
import { syncImage } from './screenshots/upload.js';
import { confirmProd, n, openStage, parseStageArgs, requireSchema } from './stage-command';

const USAGE = 'usage: bun run removals --stage local|prod [--dry-run] [--yes] [--json]';
const JSON_OUT = process.argv.includes('--json');

/** The `--json` result: the last stdout line, whatever the outcome. */
export interface RemovalsResult {
	ok: boolean;
	/** The ✓ or ✗ line. */
	summary: string;
	stage: string | null;
	dryRun: boolean;
	stopped: boolean;
	/** Deleted prints in the stage (tombstones), and how many of them were taken down on request. */
	deleted: number;
	takedowns: number;
	/** Deleted prints this run swept for the first time (or again, deleted again since). */
	newlySwept: number;
	blocksAdded: number;
	blocksDropped: number;
	localRows: number;
	diskPaths: number;
	lateRenderFiles: number;
	screenshots: number;
	nothingToDo: boolean;
}

const result: RemovalsResult = {
	ok: false,
	summary: '',
	stage: null,
	dryRun: process.argv.includes('--dry-run'),
	stopped: false,
	deleted: 0,
	takedowns: 0,
	newlySwept: 0,
	blocksAdded: 0,
	blocksDropped: 0,
	localRows: 0,
	diskPaths: 0,
	lateRenderFiles: 0,
	screenshots: 0,
	nothingToDo: false
};

// With --json, stdout is the result's alone: what libraries print (wrangler) goes to stderr. The last error
// printed (a usage error) names why a run that never got going stopped.
let lastError: string | null = null;
const toStderr = console.error.bind(console);
console.error = (...args: unknown[]) => {
	lastError = args.map(String).join(' ').split('\n')[0].replace(/^✗ /, '');
	toStderr(...args);
};
if (JSON_OUT) console.log = console.info = toStderr;

/** Progress lines: stdout, or stderr with --json (written at once, as the exit hook may print last). */
const say = (line: string) => writeSync(JSON_OUT ? 2 : 1, `${line}\n`);
let reported = false;
/** The summary line, then (with --json) the result: always the last things written. */
const report = (ok: boolean, summary: string) => {
	if (reported) return;
	reported = true;
	Object.assign(result, { ok, summary });
	say(summary);
	if (JSON_OUT) writeSync(1, `${JSON.stringify(result)}\n`);
};
// Every way out ends with a summary (a usage error, the second signal, an exit from a library), but -h.
process.on('exit', (code) => {
	if (code === 0 && !reported && !result.stage) return;
	if (!reported) {
		report(
			false,
			result.stopped ? '✗ stopped before finishing; run it again to finish' : `✗ ${lastError ?? `exited (${code}) before finishing`}`
		);
	}
});

const { flags, stage, generation } = parseStageArgs(USAGE, { json: { type: 'boolean', default: false } });
const dryRun = Boolean(flags['dry-run']);
result.stage = stage;
const ROOT = join(import.meta.dirname, '..');

// wrangler's platform proxy installs handlers that exit at once, so ours go on again once the stages are
// open: the first signal stops between prints, the second quits at once.
let stopping = false;
const onSignals = () => {
	for (const sig of ['SIGINT', 'SIGTERM'] as const) {
		process.removeAllListeners(sig);
		process.on(sig, () => {
			result.stopped = true;
			if (stopping) process.exit(130); // the exit hook prints the summary
			stopping = true;
			say(`${sig}: stopping after the current print (again to quit now)`);
		});
	}
};
onSignals();
const target = await openStage(stage, generation);
// The local D1: the render queue, the copy of the blocks and the sweeps. For --stage local it is the target itself.
const local = stage === 'local' ? target : await openStage('local', undefined);
onSignals();
const checkpoint = () => {
	if (stopping) throw new Error('stopped before finishing; run it again to finish');
};

const sweptStatement = (ldb: D1Database, id: string, tombAt: number) =>
	ldb
		.prepare(
			`INSERT INTO removal_sweeps (stage, print_id, tomb_at, swept_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (stage, print_id) DO UPDATE SET tomb_at = excluded.tomb_at, swept_at = excluded.swept_at`
		)
		.bind(stage, id, tombAt, Date.now());

let code = 0;
try {
	const db = target.env.DB;
	const ldb = local.env.DB;
	await requireSchema(db, stage, 'SELECT print_id FROM print_tombstones LIMIT 0', 'print_tombstones table', '0021');
	await requireSchema(ldb, 'local', 'SELECT print_id FROM removal_sweeps LIMIT 0', 'removal_sweeps table', '0021');

	const live = liveRun(
		(await ldb.prepare('SELECT id, state, updated_at FROM render_runs').all<{ id: string; state: RunState; updated_at: number }>()).results,
		Date.now()
	);
	if (live) throw new Error(`render run ${live.id} is live (${live.state}); run this when it has finished`);

	const tombs = (await db.prepare('SELECT print_id, kind, at FROM print_tombstones ORDER BY at').all<Tombstone>()).results;
	const blocks = await loadBlocks(db);
	const sweeps = (await ldb.prepare('SELECT print_id, tomb_at FROM removal_sweeps WHERE stage = ?').bind(stage).all<Sweep>()).results;
	const fresh = unswept(tombs, sweeps);
	result.deleted = tombs.length;
	result.takedowns = tombs.filter((t) => t.kind === 'takedown').length;
	say(
		`${stage}: ${n(tombs.length)} deleted prints (${n(result.takedowns)} on request), ${n(fresh.length)} not swept here yet; ${n(blocks.length)} blocks`
	);

	// 1. The local copy of the blocks.
	const changes = stage === 'local' ? { add: [], drop: [] } : blockChanges(blocks, await loadBlocks(ldb));
	say(`local blocks: ${n(changes.add.length)} to add, ${n(changes.drop.length)} to drop`);

	// 2. Local rows of deleted prints (all of them: local reads only).
	const ids = tombs.map((t) => t.print_id);
	const where = stage === 'local' ? `target = 'local' AND ` : '';
	const tables = LOCAL_PRINT_TABLES.filter((t) => stage === 'prod' || ['render_uploads', 'render_deletes', 'thumb_uploads'].includes(t));
	const rowCounts = new Map<string, number>();
	for (const table of tables) {
		let count = 0;
		for (let i = 0; i < ids.length; i += 50) {
			const chunk = ids.slice(i, i + 50);
			const row = await ldb
				.prepare(`SELECT count(*) AS c FROM ${table} WHERE ${where}print_id IN (${chunk.map(() => '?').join(', ')})`)
				.bind(...chunk)
				.first<{ c: number }>();
			count += row?.c ?? 0;
		}
		if (count) rowCounts.set(table, count);
	}
	say(`local rows: ${rowCounts.size ? [...rowCounts].map(([t, c]) => `${t} ${n(c)}`).join(', ') : 'none'}`);

	const dirs = { renders: rendersDir(ROOT), thumbs: thumbsDir(ROOT), raw: join(ROOT, 'data', 'raw'), records: recordsDir(ROOT) };
	const paths = stage === 'prod' ? ids.flatMap((id) => printPaths(id, dirs)).filter((p) => existsSync(p)) : [];
	say(`on disk: ${n(paths.length)} folders and files${paths.length ? `, e.g. ${paths[0]}` : ''}`);

	const shotDir = screenshotsDir(ROOT);
	const stateFile = join(shotDir, STATE_FILE);
	const { entries } = parseState(await readFile(stateFile, 'utf8').catch(() => ''));
	const images = stage === 'prod' ? imageBlocks(blocks).filter((b) => entries.get(b.image)?.status !== 'removed') : [];
	say(`screenshots to take down here: ${n(images.length)}`);

	checkpoint();
	const rows = [...rowCounts.values()].reduce((a, b) => a + b, 0);
	Object.assign(result, { blocksAdded: changes.add.length, blocksDropped: changes.drop.length, localRows: rows, diskPaths: paths.length });
	result.nothingToDo = changes.add.length + changes.drop.length + rowCounts.size + paths.length + images.length + fresh.length === 0;
	if (dryRun) {
		report(true, result.nothingToDo ? '✓ dry run; nothing to do' : '✓ dry run; nothing changed');
	} else if (result.nothingToDo) {
		report(true, '✓ nothing to do');
	} else {
		await confirmProd(stage, Boolean(flags.yes), `Sweep ${n(ids.length)} deleted prints from this machine and prod's buckets?`);

		const stmts = [
			...changes.drop.map((b) => ldb.prepare('DELETE FROM removal_blocks WHERE kind = ? AND value = ?').bind(b.kind, b.value)),
			...insertBlocks(ldb, changes.add)
		];
		for (let i = 0; i < stmts.length; i += 50) await ldb.batch(stmts.slice(i, i + 50));
		checkpoint();

		for (const table of rowCounts.keys()) {
			for (let i = 0; i < ids.length; i += 50) {
				checkpoint();
				const chunk = ids.slice(i, i + 50);
				await ldb
					.prepare(`DELETE FROM ${table} WHERE ${where}print_id IN (${chunk.map(() => '?').join(', ')})`)
					.bind(...chunk)
					.run();
			}
		}
		for (const p of paths) {
			checkpoint();
			await rm(p, { recursive: true, force: true });
		}

		if (stage === 'prod') {
			// 3. Prod's renders again, once per deleted print: a page uploaded while the takedown ran.
			if (fresh.length) {
				const store = await openStore('prod', null);
				for (const t of fresh) {
					checkpoint();
					for (const key of await store!.list(`${t.print_id}/`)) {
						await store!.delete(key);
						result.lateRenderFiles++;
					}
					await sweptStatement(ldb, t.print_id, t.at).run();
					result.newlySwept++;
				}
				say(`prod renders bucket: ${n(result.lateRenderFiles)} late files deleted`);
			}

			// 4. Screenshots, as screenshots:remove does them.
			if (images.length) {
				const ledger = join(shotDir, ledgerFile('prod'));
				const { held } = readLedger(await readFile(ledger, 'utf8').catch(() => ''));
				const opened = await openShotStore('prod');
				try {
					await mkdir(dirname(ledger), { recursive: true });
					const append = (l: LedgerLine) => appendFileSync(ledger, formatLine(l));
					for (const { image, print } of images) {
						checkpoint();
						const before = entries.get(image);
						const entry: StateEntry = {
							...(before ?? { id: image, prints: [print], labelled: null, attempts: 0 }),
							status: 'removed',
							reason: `print ${print} taken down`,
							at: new Date().toISOString()
						};
						appendFileSync(stateFile, formatEntry(entry));
						await syncImage({ dir: shotDir, store: opened.store, held, append }, entry, null);
						if (before?.file) await rm(join(shotDir, before.file), { force: true });
						const sizes = join(shotDir, SIZES_DIR, image.slice(0, 2));
						for (const f of await readdir(sizes).catch(() => [] as string[])) {
							if (f.startsWith(`${image}.`)) await rm(join(sizes, f), { force: true });
						}
						result.screenshots++;
					}
				} finally {
					await opened.dispose();
				}
				say(`screenshots: ${n(images.length)} taken down here and in prod's bucket`);
			}
		} else {
			// Nothing remote to sweep for the local stage: its rows are all there is.
			for (let i = 0; i < fresh.length; i += 50) {
				checkpoint();
				await ldb.batch(fresh.slice(i, i + 50).map((t) => sweptStatement(ldb, t.print_id, t.at)));
				result.newlySwept += Math.min(50, fresh.length - i);
			}
		}
		report(
			true,
			`✓ ${n(result.newlySwept)} deleted prints newly swept (${n(tombs.length)} in all): blocks +${n(changes.add.length)}/−${n(changes.drop.length)}, ` +
				`${n(rows)} local rows, ${n(paths.length)} paths on disk, ${n(result.lateRenderFiles)} late render files, ${n(result.screenshots)} screenshots`
		);
	}
} catch (e) {
	code = 2;
	report(false, `✗ ${e instanceof Error ? e.message : String(e)}`);
} finally {
	if (local !== target) await local.dispose();
	await target.dispose();
}
process.exit(code);
