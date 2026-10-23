/**
 * The command line shared by the scripts that write to one stage's D1 (`authors`, `render:flags`,
 * `views:sync`): `--stage local|prod [--db N] [--dry-run] [--yes] [-h]` plus each script's own
 * flags, the stage opened through the backfill's bindings (scripts/backfill/stage.ts), a typed
 * "prod" before writing to prod, and one way out: dispose of the target, then exit 0, or 2 with
 * the error.
 */
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
 * a missing or unknown `--stage` or a bad `--db` fails with it.
 */
export const parseStageArgs = <O extends ParseArgsOptionsConfig>(usage: string, options: O) => {
	const { values: flags } = (() => {
		try {
			return parseArgs({ options: { ...COMMON, ...options }, strict: true });
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
	return { flags, stage, generation };
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
