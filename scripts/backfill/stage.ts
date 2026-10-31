/**
 * Where a backfill writes: `local` is the miniflare state `bun run dev` uses (wrangler.jsonc, as
 * scripts/ingest.ts does); every other stage (`prod`, and any added to STAGES in infra/databases.ts)
 * is the Alchemy-deployed D1 database and R2 bucket (docs/deploy.md), reached through wrangler's
 * remote bindings with your `wrangler login`.
 *
 * For a remote stage this writes a throwaway wrangler config under .wrangler/backfill/ with
 * `remote: true` bindings, and a Node sidecar (remote-bindings.mjs) opens wrangler's remote proxy
 * session for it with `getPlatformProxy` (a temporary preview Worker that forwards binding calls;
 * nothing is deployed). wrangler.jsonc is never edited.
 *
 * An update (scripts/sync.ts) opens its stage once with `openSharedStage` and names that sidecar to its
 * steps in SHARED_STAGE_ENV; `openTarget` in a step attaches to it when the stage and D1 generation
 * match and it answers, else opens its own as before. An attached handle's dispose leaves the sidecar
 * running: the update ends it.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { DATABASES, PREFIX, STAGES as DEPLOYED_STAGES, type Stage as DeployedStage } from '../../infra/databases';
import { connectRemote, openRemoteBindings, pingRemote, startSidecar } from './remote';

export const STAGES = ['local', ...DEPLOYED_STAGES] as const;
export type Stage = (typeof STAGES)[number];

const ROOT = join(import.meta.dirname, '..', '..');

export class TargetError extends Error {}

let resolvedAccountId: string | null = null;

/**
 * The Cloudflare account a remote stage lives in: `CLOUDFLARE_ACCOUNT_ID` if set, otherwise the only
 * account `wrangler whoami` lists for the logged-in user. Several accounts and no variable is an error.
 */
export const accountId = (): string => {
	const fromEnv = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
	if (fromEnv) return fromEnv;
	if (resolvedAccountId) return resolvedAccountId;
	const out = spawnSync(join(ROOT, 'node_modules', '.bin', 'wrangler'), ['whoami', '--json'], {
		cwd: ROOT,
		encoding: 'utf8',
		env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: undefined }
	});
	const stdout = out.stdout ?? '';
	const start = stdout.indexOf('{');
	let accounts: { id: string; name: string }[] = [];
	try {
		if (out.status === 0 && start >= 0)
			accounts = (JSON.parse(stdout.slice(start)) as { accounts?: { id: string; name: string }[] }).accounts ?? [];
	} catch {
		accounts = [];
	}
	if (accounts.length === 1) return (resolvedAccountId = accounts[0].id);
	if (accounts.length === 0) {
		throw new TargetError(
			`couldn't find a Cloudflare account: log in with \`bunx wrangler login\` or set CLOUDFLARE_ACCOUNT_ID.\n${(out.stderr || stdout).trim()}`
		);
	}
	throw new TargetError(
		`you have access to ${accounts.length} Cloudflare accounts; set CLOUDFLARE_ACCOUNT_ID to the one to use:\n` +
			accounts.map((a) => `  ${a.id}  ${a.name}`).join('\n')
	);
};

export interface Bindings {
	readonly DB: D1Database;
	readonly RAW: R2Bucket;
}

export interface Target {
	readonly stage: Stage;
	/** What it writes to, for the confirmation and the status line. */
	readonly database: string;
	readonly bucket: string;
	readonly env: Bindings;
	readonly dispose: () => Promise<void>;
}

/** The D1 generation the stage's Worker is bound to (infra/databases.ts). `--db <n>` overrides it. */
export const boundGeneration = (stage: DeployedStage): number => DATABASES[stage].bound;

export const resourceNames = (stage: DeployedStage, generation: number) => ({
	database: `${PREFIX}-${stage}-db-${generation}`,
	raw: `${PREFIX}-${stage}-raw`,
	renders: `${PREFIX}-${stage}-renders`
});

/** The generated wrangler config for a remote stage: only the bindings the backfill uses, all remote. */
export const remoteConfig = (stage: DeployedStage, names: ReturnType<typeof resourceNames>, databaseId: string) => ({
	name: `${PREFIX}-${stage}-backfill`,
	account_id: accountId(),
	compatibility_date: '2026-10-18',
	d1_databases: [{ binding: 'DB', database_name: names.database, database_id: databaseId, remote: true }],
	r2_buckets: [{ binding: 'RAW', bucket_name: names.raw, remote: true }]
});

const wrangler = (args: string[]) => {
	const out = spawnSync(join(ROOT, 'node_modules', '.bin', 'wrangler'), args, {
		cwd: ROOT,
		encoding: 'utf8',
		// No WRANGLER_LOG: a debug level pollutes the JSON on stdout, and "error" suppresses it.
		env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId(), WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: undefined }
	});
	return { ok: out.status === 0, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
};

/**
 * `wrangler`, retried on "Authentication error [code: 10000]": seen once right as the OAuth access
 * token expired, and gone on the next call (wrangler refreshes it).
 */
const wranglerRetrying = (args: string[]) => {
	for (let attempt = 0; ; attempt++) {
		const r = wrangler(args);
		if (r.ok || attempt >= 2 || !/Authentication error|code: 10000/.test(`${r.stdout}${r.stderr}`)) return r;
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
	}
};

const notDeployed = (stage: string, what: string) =>
	new TargetError(
		`${what} doesn't exist in Cloudflare account ${accountId()}. Nothing is deployed for "${stage}" yet: ` +
			`run \`bun run deploy:${stage}\` first (docs/deploy.md), then run this command again.`
	);

/** D1 database id by name (`wrangler d1 list --json`; needs `wrangler login`). */
export const findDatabaseId = (stage: DeployedStage, name: string): string => {
	const r = wranglerRetrying(['d1', 'list', '--json']);
	const json = r.stdout.slice(r.stdout.indexOf('['));
	if (!r.ok || !json.startsWith('[')) {
		throw new TargetError(`\`wrangler d1 list\` failed (logged in? try \`bunx wrangler whoami\`):\n${(r.stderr || r.stdout).trim()}`);
	}
	const db = (JSON.parse(json) as { uuid: string; name: string }[]).find((d) => d.name === name);
	if (!db) throw notDeployed(stage, `D1 database ${name}`);
	return db.uuid;
};

export const checkBucket = (stage: DeployedStage, name: string) => {
	const r = wranglerRetrying(['r2', 'bucket', 'info', name, '--json']);
	if (r.ok) return;
	const text = `${r.stdout}\n${r.stderr}`;
	if (/does not exist|10006/.test(text)) throw notDeployed(stage, `R2 bucket ${name}`);
	throw new TargetError(`\`wrangler r2 bucket info ${name}\` failed:\n${text.trim()}`);
};

/** Fail early, with what to do, when the schema isn't there. */
const checkSchema = async (stage: Stage, db: D1Database) => {
	const { results } = await db
		.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('pipeline_runs', 'ingest_state', 'prints', 'print_renders', 'authors', 'removal_blocks')`
		)
		.all<{ name: string }>();
	if (results.length < 6) {
		// removal_blocks (0021) is the newest table a print's write reads.
		throw new TargetError(
			stage === 'local'
				? 'the local D1 database lacks the latest tables (pipeline_runs, ingest_state, print_renders, authors, removal_blocks): run `bun run db:migrate`'
				: `the ${stage} D1 database lacks the latest tables (pipeline_runs, ingest_state, print_renders, authors, removal_blocks): deploy applies migrations (\`bun run deploy:${stage}\`)`
		);
	}
};

export const configPath = (stage: DeployedStage) => join(ROOT, '.wrangler', 'backfill', `wrangler.${stage}.json`);

/**
 * Resolve and connect to the stage. Remote stages check that the database and bucket exist before
 * opening a remote session, so "not deployed yet" is a clear message rather than a proxy error.
 */
export const openTarget = async (stage: Stage, options: { generation?: number; log?: (line: string) => void } = {}): Promise<Target> => {
	if (stage === 'local') {
		const proxy = await getPlatformProxy<Env>({ persist: true, remoteBindings: false });
		const env = { DB: proxy.env.DB, RAW: proxy.env.RAW };
		try {
			await checkSchema(stage, env.DB);
		} catch (e) {
			await proxy.dispose();
			throw e;
		}
		return { stage, database: 'local D1 (.wrangler/state)', bucket: 'local R2 prints-raw', env, dispose: () => proxy.dispose() };
	}
	return openRemoteTarget(stage, options.generation ?? boundGeneration(stage), options.log ?? ((line: string) => console.log(line)));
};

/** How a remote stage is reached: attach to the update's sidecar, else open one. Tests replace both. */
export interface RemoteDeps {
	attach: (shared: SharedStage, log: (line: string) => void) => Promise<Target | null>;
	open: (stage: DeployedStage, generation: number, log: (line: string) => void) => Promise<Target>;
}

/** This process's own sidecar, as every standalone script opens it. */
const openOwn = async (stage: DeployedStage, generation: number, log: (line: string) => void): Promise<Target> => {
	const { names, databaseId, path } = await prepareRemote(stage, generation);
	// Under Bun, wrangler's remote proxy session never connects, so a Node sidecar holds it (remote-bindings.mjs).
	const remote = await openRemoteBindings(path, log);
	const env = { DB: remote.DB, RAW: remote.RAW };
	try {
		await checkSchema(stage, env.DB);
	} catch (e) {
		await remote.dispose();
		throw e;
	}
	return { stage, database: `${names.database} (${databaseId})`, bucket: names.raw, env, dispose: remote.dispose };
};

/** A remote stage: the update's shared sidecar when SHARED_STAGE_ENV names this stage and generation and it answers, else its own. */
export const openRemoteTarget = async (
	stage: DeployedStage,
	generation: number,
	log: (line: string) => void,
	deps: RemoteDeps = { attach: (shared, l) => attachShared(shared, l), open: openOwn },
	environ: Record<string, string | undefined> = process.env
): Promise<Target> => {
	const shared = sharedStage(environ, stage, generation);
	if (shared) {
		const attached = await deps.attach(shared, log);
		if (attached) return attached;
	}
	return deps.open(stage, generation, log);
};

/** Check the database and bucket exist, and write the sidecar's wrangler config. */
const prepareRemote = async (stage: DeployedStage, generation: number) => {
	const names = resourceNames(stage, generation);
	const databaseId = findDatabaseId(stage, names.database);
	checkBucket(stage, names.raw);
	const path = configPath(stage);
	await mkdir(join(path, '..'), { recursive: true });
	await writeFile(path, JSON.stringify(remoteConfig(stage, names, databaseId), null, '\t') + '\n');
	return { names, databaseId, path };
};

// --- one stage connection for a whole update

/** The variable an update names its open stage in, for its steps (JSON: SharedStage). */
export const SHARED_STAGE_ENV = 'ATLAS_SHARED_STAGE';

/** A remote stage's sidecar that another process (the update) holds open. */
export interface SharedStage {
	stage: DeployedStage;
	generation: number;
	port: number;
	token: string;
	/** The sidecar's pid: gone means don't try. */
	pid: number;
	/** As Target's: `<name> (<id>)`. */
	database: string;
	bucket: string;
	/** The Cloudflare account it was resolved in, so the update needn't ask `wrangler whoami` itself. */
	account?: string;
}

const isPid = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM: it exists, owned by someone else (not ours, but alive).
		return (e as NodeJS.ErrnoException).code === 'EPERM';
	}
};

/** The shared stage in `environ` if it is this stage and D1 generation and its sidecar's process still runs, else null. */
export const sharedStage = (
	environ: Record<string, string | undefined>,
	stage: Stage,
	generation: number,
	running: (pid: number) => boolean = isPid
): SharedStage | null => {
	const text = environ[SHARED_STAGE_ENV];
	if (!text) return null;
	let s: Partial<SharedStage>;
	try {
		s = JSON.parse(text) as Partial<SharedStage>;
	} catch {
		return null;
	}
	const ok =
		s.stage === stage &&
		s.generation === generation &&
		Number.isInteger(s.port) &&
		typeof s.token === 'string' &&
		Number.isInteger(s.pid) &&
		typeof s.database === 'string' &&
		typeof s.bucket === 'string';
	return ok && running(s.pid!) ? (s as SharedStage) : null;
};

/**
 * A Target on the update's sidecar, after a health check (it may have lost its session over a long update);
 * null when it doesn't answer, and the caller opens its own. Its dispose leaves the sidecar to the update.
 */
export const attachShared = async (
	shared: SharedStage,
	log: (line: string) => void,
	ping: (port: number, token: string) => Promise<boolean> = pingRemote
): Promise<Target | null> => {
	if (!(await ping(shared.port, shared.token))) {
		log(`  the update's ${shared.stage} connection (pid ${shared.pid}) didn't answer: opening a new one`);
		return null;
	}
	const remote = connectRemote(shared.port, shared.token);
	const env = { DB: remote.DB, RAW: remote.RAW };
	await checkSchema(shared.stage, env.DB);
	return { stage: shared.stage, database: shared.database, bucket: shared.bucket, env, dispose: async () => undefined };
};

/**
 * Open a remote stage for a whole update: the checks and sidecar `openTarget` would start. Run by
 * scripts/backfill/hold-stage.ts, a process of its own that the update starts (so wrangler's blocking calls
 * never stall the update's heartbeat) and ends. `env` is the value of SHARED_STAGE_ENV for the steps.
 */
export const openSharedStage = async (
	stage: DeployedStage,
	options: { generation?: number; log?: (line: string) => void } = {}
): Promise<{ env: string; pid: number; database: string; dispose: () => Promise<void> }> => {
	const generation = options.generation ?? boundGeneration(stage);
	const { names, databaseId, path } = await prepareRemote(stage, generation);
	const sidecar = await startSidecar(path, options.log ?? ((line) => console.log(line)), { shared: true });
	try {
		await checkSchema(stage, connectRemote(sidecar.port, sidecar.token).DB);
	} catch (e) {
		await sidecar.dispose();
		throw e;
	}
	const shared: SharedStage = {
		stage,
		generation,
		port: sidecar.port,
		token: sidecar.token,
		pid: sidecar.pid,
		database: `${names.database} (${databaseId})`,
		bucket: names.raw,
		account: accountId()
	};
	return { env: JSON.stringify(shared), pid: sidecar.pid, database: shared.database, dispose: sidecar.dispose };
};
