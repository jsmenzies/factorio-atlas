/**
 * `bun run records --stage local|prod [--dir DIR] [--dry-run] [--json]`: bring this machine's record
 * store (scripts/records/store.ts: RECORDS_DIR, else ~/data/factorio-records) in line with the stage, for
 * every site whose records live there (today uploads: scripts/records/uploads.ts). Only new and changed
 * records are fetched; those the site no longer has (deleted, taken down) leave the store. The render
 * runs read the store beside the mirror clone, so uploads get renders and thumbnails like any print.
 *
 * Read-only on the stage (D1 selects and RAW reads; prod through the backfill's Node sidecar); writes only
 * the store. The one-click update runs it in its fetch step, after the sources (which admit waiting
 * uploads first).
 *
 * The first SIGINT or SIGTERM stops it between records, the second at once. Exit 0 when done, 2 on any
 * error or when stopped (130 on the second signal); the last line starts with ✓ or ✗. With `--json` every
 * line goes to stderr and the last stdout line is the result as JSON (`RecordsResult`), whatever the
 * outcome.
 *
 *   --dir DIR   the store (default RECORDS_DIR, else ~/data/factorio-records)
 *   --dry-run   count what would change, fetch and write nothing
 *   --json      the result as JSON on stdout (for the one-click update)
 */
import { writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { n, openStage, parseStageArgs, requireSchema } from './stage-command';
import { pullSite, type PullCounts, type StoreAdapter } from './records/pull';
import { recordsDir, storePrintIds } from './records/store';
import { factoriobinStoreAdapter } from './records/factoriobin';
import { uploadsStoreAdapter } from './records/uploads';

const USAGE = 'usage: bun run records --stage local|prod [--dir DIR] [--dry-run] [--json]';
const JSON_OUT = process.argv.includes('--json');

/** The `--json` result: the last stdout line. */
export interface RecordsResult {
	ok: boolean;
	summary: string;
	stage: string | null;
	dir: string;
	dryRun: boolean;
	stopped: boolean;
	/** Per site, how its pull came out. */
	sites: Record<string, PullCounts>;
	/** Records in the store at the end, every site. */
	total: number;
}

const result: RecordsResult = { ok: false, summary: '', stage: null, dir: '', dryRun: false, stopped: false, sites: {}, total: 0 };

let lastError: string | null = null;
const toStderr = console.error.bind(console);
console.error = (...args: unknown[]) => {
	lastError = args.map(String).join(' ').split('\n')[0].replace(/^✗ /, '');
	toStderr(...args);
};
if (JSON_OUT) console.log = console.info = console.warn = toStderr;

const say = (line: string) => writeSync(JSON_OUT ? 2 : 1, `${line}\n`);
let reported = false;
const report = (ok: boolean, summary: string) => {
	if (reported) return;
	reported = true;
	Object.assign(result, { ok, summary });
	say(summary);
	if (JSON_OUT) writeSync(1, `${JSON.stringify(result)}\n`);
};
process.on('exit', (code) => {
	if (code === 0 && !reported && !result.stage) return;
	if (!reported) report(false, result.stopped ? '✗ stopped before finishing' : `✗ ${lastError ?? `exited (${code}) before finishing`}`);
});

const { flags, stage, generation } = parseStageArgs(USAGE, {
	dir: { type: 'string' },
	json: { type: 'boolean', default: false }
});
result.stage = stage;
result.dryRun = Boolean(flags['dry-run']);
result.dir = flags.dir ? resolve(flags.dir) : recordsDir();

let stopping = false;
const onSignals = () => {
	for (const sig of ['SIGINT', 'SIGTERM'] as const) {
		process.removeAllListeners(sig);
		process.on(sig, () => {
			result.stopped = true;
			if (stopping) process.exit(130);
			stopping = true;
			say(`${sig}: stopping after the records being fetched (again to quit now)`);
		});
	}
};
onSignals();
const target = await openStage(stage, generation);
onSignals();

let code = 0;
try {
	const env = target.env;
	await requireSchema(env.DB, stage, 'SELECT print_id FROM uploads LIMIT 0', 'uploads table', '0024');
	/** Every site that feeds the store; factoriobin and the others join here. */
	const adapters: StoreAdapter[] = [uploadsStoreAdapter(env), factoriobinStoreAdapter(env)];
	say(`${stage} → record store ${result.dir}${result.dryRun ? ' (dry run)' : ''}`);
	const parts: string[] = [];
	for (const adapter of adapters) {
		if (stopping) break;
		const c = await pullSite(result.dir, adapter, {
			dryRun: result.dryRun,
			stopping: () => stopping,
			log: (line) => say(`  ${line}`)
		});
		result.sites[adapter.site] = c;
		parts.push(
			`${adapter.site}: ${n(c.listed)} on the site, ${n(c.added)} new, ${n(c.changed)} changed, ${n(c.removed + c.vanished)} removed` +
				(c.failed ? `, ${n(c.failed)} failed` : '') +
				(c.left ? `, ${n(c.left)} ${result.dryRun ? 'to do' : 'left'}` : '')
		);
	}
	result.total = (await storePrintIds(result.dir)).length;
	const failed = Object.values(result.sites).reduce((s, c) => s + c.failed, 0);
	const line = `${parts.join(' · ')}; ${n(result.total)} records in the store`;
	if (stopping) {
		code = 2;
		report(false, `✗ stopped: ${line}`);
	} else if (failed) {
		code = 2;
		report(false, `✗ ${line}`);
	} else report(true, `✓ ${line}`);
} catch (e) {
	code = 2;
	report(false, `✗ ${e instanceof Error ? e.message : String(e)}`);
} finally {
	await target.dispose();
}
process.exit(code);
