/**
 * The command line shared by the scripts that write to one stage's D1 (`authors`, `render:flags`,
 * `views:sync`): `--stage local|prod [--db N] [--dry-run] [--yes] [-h]` plus each script's own
 * flags, the stage opened through the backfill's bindings (scripts/backfill/stage.ts), a typed
 * "prod" before writing to prod, and one way out: dispose of the target, then exit 0, or 2 with
 * the error.
 */
import { writeSync } from 'node:fs';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { openTarget, STAGES, TargetError, type Stage, type Target } from './backfill/stage';
import { Terminal } from './backfill/terminal';

/** Print the message and exit with status 2. */
export const fail = (message: string): never => {
	console.error(message);
	process.exit(2);
};

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const n = (x: number) => x.toLocaleString('en-US');

const COMMON = {
	stage: { type: 'string' },
	db: { type: 'string' },
	'dry-run': { type: 'boolean', default: false },
	yes: { type: 'boolean', default: false },
	help: { type: 'boolean', short: 'h', default: false }
} as const;

/**
 * The command line: the common flags plus `options`. `-h` prints `usage` and exits; a bad flag,
 * a missing or unknown `--stage` or a bad `--db` fails with it. Arguments that aren't flags are an error
 * unless `allowPositionals` (then they come back as `positionals`).
 */
export const parseStageArgs = <O extends ParseArgsOptionsConfig>(usage: string, options: O, allowPositionals = false) => {
	const { values: flags, positionals } = (() => {
		try {
			return parseArgs({ options: { ...COMMON, ...options }, strict: true, allowPositionals });
		} catch (e) {
			return fail(`${messageOf(e)}\n${usage}`);
		}
	})();
	// The common flags by themselves: TypeScript can't see them through the generic result.
	const common = flags as { help: boolean; stage?: string; db?: string };
	if (common.help) {
		console.log(usage);
		process.exit(0);
	}
	const stage = common.stage as Stage;
	if (!STAGES.includes(stage)) fail(`--stage ${STAGES.join('|')} is required\n${usage}`);
	const generation = common.db === undefined ? undefined : Number(common.db);
	if (generation !== undefined && !(Number.isInteger(generation) && generation > 0)) fail('--db must be a positive integer');
	return { flags, stage, generation, positionals };
};

/** The stage's D1 and R2, or exit with why they can't be opened. */
export const openStage = (stage: Stage, generation: number | undefined): Promise<Target> =>
	openTarget(stage, { generation }).catch((e: unknown) => fail(e instanceof Error ? `✗ ${e.message}` : String(e)));

/**
 * Throws a TargetError unless `sql` runs on the stage's D1: `what` names what it reads ("authors
 * table"), `migration` the migration that adds it.
 */
export const requireSchema = (db: D1Database, stage: Stage, sql: string, what: string, migration: string) =>
	db
		.prepare(sql)
		.all()
		.then(
			() => undefined,
			() => {
				throw new TargetError(
					stage === 'local'
						? `the local D1 database has no ${what}: run \`bun run db:migrate\``
						: `the ${stage} D1 database has no ${what}: deploy applies migration ${migration}`
				);
			}
		);

/** On prod without `--yes`, ask for "prod" to be typed; anything else, or no terminal to ask in, throws. */
export const confirmProd = async (stage: Stage, yes: boolean, question: string) => {
	if (stage !== 'prod' || yes) return;
	const term = new Terminal();
	if (!term.tty) throw new TargetError('refusing to write to prod without a terminal to confirm in: pass --yes');
	if ((await term.ask(`${question} Type "prod" to continue: `)) !== 'prod') throw new TargetError('not confirmed; nothing written');
};

/** Run `body`, dispose of the target, then exit: 0 when it finished, 2 with its error. */
export const runOn = async (target: Target, body: () => Promise<void>): Promise<never> => {
	try {
		await body();
	} catch (e) {
		await target.dispose();
		return fail(`✗ ${messageOf(e)}`);
	}
	await target.dispose();
	process.exit(0);
};

/** The fields every `--json` script's result has (records, polled, removals, uploads). */
export interface JsonScriptResult {
	ok: boolean;
	summary: string;
	stage: string | null;
	stopped: boolean;
}

/**
 * The shared shape of a script the update runs with `--json`. With `--json`, stdout is the result's alone (its
 * last line): what libraries print (wrangler) goes to stderr. The last error printed (a usage error) names why a
 * run that never got going stopped. Call it before parsing the command line, so a usage error is caught too.
 * - `say`: progress lines, stdout or stderr with `--json` (written at once, as the exit hook may print last).
 * - `report`: the summary line, then (with `--json`) the result: always the last things written, once.
 * - Every way out ends with a summary (a usage error, the second signal, an exit from a library), but -h:
 *   `stoppedSummary` when a signal stopped it, else the last error.
 * - `onSignals`: wrangler's platform proxy installs handlers that exit at once, so call it again once the stage
 *   is open. The first SIGINT/SIGTERM sets `stopping` (stop after `stopAfter`), the second quits at once (130).
 */
export function jsonScript<R extends JsonScriptResult>(result: R, words: { stoppedSummary: string; stopAfter: string }) {
	const json = process.argv.includes('--json');
	let lastError: string | null = null;
	const toStderr = console.error.bind(console);
	console.error = (...args: unknown[]) => {
		lastError = args.map(String).join(' ').split('\n')[0].replace(/^✗ /, '');
		toStderr(...args);
	};
	if (json) console.log = console.info = console.warn = toStderr;

	const say = (line: string) => writeSync(json ? 2 : 1, `${line}\n`);
	let reported = false;
	const report = (ok: boolean, summary: string) => {
		if (reported) return;
		reported = true;
		Object.assign(result, { ok, summary });
		say(summary);
		if (json) writeSync(1, `${JSON.stringify(result)}\n`);
	};
	process.on('exit', (code) => {
		if (code === 0 && !reported && !result.stage) return;
		if (!reported) report(false, result.stopped ? words.stoppedSummary : `✗ ${lastError ?? `exited (${code}) before finishing`}`);
	});

	let stopping = false;
	const onSignals = () => {
		for (const sig of ['SIGINT', 'SIGTERM'] as const) {
			process.removeAllListeners(sig);
			process.on(sig, () => {
				result.stopped = true;
				if (stopping) process.exit(130); // the exit hook prints the summary
				stopping = true;
				say(`${sig}: stopping after ${words.stopAfter} (again to quit now)`);
			});
		}
	};
	return {
		say,
		report,
		onSignals,
		/** A first signal came: stop at the next safe point. */
		stopping: () => stopping
	};
}
