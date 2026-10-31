/**
 * Starting render runs from /admin/render under `vite dev` (the page's "Start a batch" panel).
 * SvelteKit's server code runs in workerd and can't start processes, so this Vite plugin answers
 * the paths below before SvelteKit sees them. It exists only under `vite dev` (`apply: 'serve'`);
 * deployed, these paths are ordinary 404s and the panel is hidden.
 *
 *   GET  /admin/render/__control/status   what a start needs: the mirror clone, the sprite assets, whether
 *                                 R2 credentials are set (never their values), a live run, the latest log;
 *                                 `busy: true` (and `live: null`) while a run's writes keep the database locked
 *   POST /admin/render/__control/start    {"next": N, "upload": "none"|"local"|"prod", "force"?: bool, "workers"?: N,
 *                                 "top"?: N, "refreshTop"?: bool} or {"resume": true}: starts
 *                                 `bun scripts/render-game.ts …` detached, so the run outlives a dev server
 *                                 restart; output goes to <renders dir>/logs/
 *   GET  /admin/render/__control/log      the last lines of the latest log (`?lines=N`)
 *   POST /admin/render/__control/top      {"n": N}: recompute the top-N favourites from the clone
 *                                 (`bun scripts/render-scope.ts top N`, waits for it)
 *   POST /admin/render/__control/check    {}: compare the clone's record files with the stamps the runs
 *                                 recorded (`bun scripts/render-scope.ts check`)
 *   POST /admin/render/__control/pull     {}: `git -C <clone> pull --ff-only`; refused while a run is live
 *
 * The page reads what top and check store (render_favorites, render_source_changes, render_meta) in
 * its one database batch; the file work happens here, never in the Worker.
 *
 * The command line is built here from validated numbers and fixed flags, and the process is spawned
 * without a shell. The clone comes from RENDER_CLONE_DIR (default ~/data/factorio-mirror) and the
 * assets from FPSR_ASSETS_DIR, in the environment or .env.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv, type Plugin } from 'vite';
import { LIVE_STATES } from '#lib/server/pipeline/runs.js';
import { RENDER_STALE_MS } from '#lib/server/render-queue.js';
import { rendersDir } from '#lib/server/renders-dir.js';
import { LIVE_SYNC_WHERE, liveSyncParams } from '#lib/server/sync.js';
import { defaultAssets } from './assets-dir.js';

const ROOT = join(import.meta.dirname, '..', '..');
/** The run logs, in the renders folder (RENDERS_DIR from .env or the environment; set in configResolved). */
let LOG_DIR = join(rendersDir(ROOT), 'logs');
const D1_DIR = join(ROOT, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
const LOG_NAME = /^render-[0-9TZ-]+\.log$/;
/** SQLite's lock errors: a run writing to the database at that moment. */
const LOCKED = /SQLITE_BUSY|database is locked/i;
/**
 * How long a read waits for a run's write lock (node:sqlite's busy timeout). node:sqlite blocks the
 * dev server's thread while it waits, so briefly: the page asks again in 2 s.
 */
const BUSY_TIMEOUT_MS = 100;

/** The runner's flags for a request, or an error message. Pure: only validated numbers and fixed words get through. */
export function startArgs(body: unknown, cloneDir: string): string[] | string {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return 'expected a JSON object';
	const b = body as Record<string, unknown>;
	const allowed = new Set(['next', 'upload', 'force', 'workers', 'top', 'refreshTop', 'resume']);
	const unknown = Object.keys(b).filter((k) => !allowed.has(k));
	if (unknown.length) return `unknown field: ${unknown.join(', ')}`;
	const int = (k: string, max: number) => {
		const v = b[k];
		return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max ? v : null;
	};
	if (b.resume !== undefined) {
		if (b.resume !== true || Object.keys(b).length > 1) return '"resume" must be true and alone';
		return ['--resume'];
	}
	const next = int('next', 100_000);
	if (next === null) return '"next" must be a whole number from 1 to 100000';
	const upload = b.upload ?? 'none';
	if (upload !== 'none' && upload !== 'local' && upload !== 'prod') return '"upload" must be "none", "local" or "prod"';
	if (b.force !== undefined && typeof b.force !== 'boolean') return '"force" must be true or false';
	if (b.workers !== undefined && int('workers', 64) === null) return '"workers" must be a whole number from 1 to 64';
	if (b.top !== undefined && int('top', 100_000) === null) return '"top" must be a whole number from 1 to 100000';
	if (b.refreshTop !== undefined && typeof b.refreshTop !== 'boolean') return '"refreshTop" must be true or false';
	if (b.refreshTop === true && b.top === undefined) return '"refreshTop" needs "top"';
	const argv = ['--from-clone', cloneDir, '--next', String(next)];
	if (b.top !== undefined) argv.push('--top', String(b.top));
	if (b.refreshTop === true) argv.push('--refresh-top');
	if (upload !== 'none') argv.push('--upload', upload);
	if (b.force === true) argv.push('--force');
	if (b.workers !== undefined) argv.push('--workers', String(b.workers));
	return argv;
}

/** The render-scope.ts command for a top or check request, or an error message. Pure, like startArgs. */
export function scopeArgs(kind: 'top' | 'check', body: unknown, cloneDir: string): string[] | string {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return 'expected a JSON object';
	const b = body as Record<string, unknown>;
	const allowed = kind === 'top' ? ['n'] : [];
	const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
	if (unknown.length) return `unknown field: ${unknown.join(', ')}`;
	if (kind === 'check') return ['check', '--from-clone', cloneDir, '--json'];
	const n = b.n;
	if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 100_000) return '"n" must be a whole number from 1 to 100000';
	return ['top', String(n), '--from-clone', cloneDir, '--json'];
}

/** Run a command to its end (without a shell, never blocking the dev server's thread): exit code and output. */
export const runToEnd = (cmd: string, argv: string[], env: NodeJS.ProcessEnv, timeoutMs: number) =>
	new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
		const child = spawn(cmd, argv, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout!.on('data', (c: Buffer) => (stdout = (stdout + c.toString('utf8')).slice(-100_000)));
		child.stderr!.on('data', (c: Buffer) => (stderr = (stderr + c.toString('utf8')).slice(-100_000)));
		const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
		child.once('error', (e) => {
			clearTimeout(timer);
			resolve({ code: -1, stdout, stderr: `${stderr}${e.message}` });
		});
		child.once('close', (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});

export const json = (res: ServerResponse, status: number, body: unknown) => {
	res.statusCode = status;
	res.setHeader('content-type', 'application/json');
	res.setHeader('cache-control', 'no-store');
	res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage, max = 4096) =>
	new Promise<string>((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => {
			size += c.length;
			if (size > max) {
				reject(new Error('body too large'));
				req.destroy();
			} else chunks.push(c);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});

/** A same-origin JSON body, or null once an error was sent. */
export async function jsonBody(req: IncomingMessage, res: ServerResponse): Promise<{ body: unknown } | null> {
	if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
		json(res, 415, { error: 'send JSON (content-type: application/json)' });
		return null;
	}
	// Only the site's own pages: a page elsewhere can't start runs through the browser.
	const origin = req.headers.origin;
	if (origin && origin !== `http://${req.headers.host}`) {
		json(res, 403, { error: 'cross-origin request refused' });
		return null;
	}
	try {
		return { body: JSON.parse(await readBody(req)) as unknown };
	} catch (e) {
		json(res, 400, { error: `bad JSON: ${e instanceof Error ? e.message : e}` });
		return null;
	}
}

const executable = (p: string) => {
	try {
		accessSync(p, constants.X_OK);
		return statSync(p).isFile();
	} catch {
		return false;
	}
};

/** bun: BUN_BIN, else on PATH, else what mise has. */
export function findBun(env: Record<string, string>): string | null {
	if (env.BUN_BIN && executable(env.BUN_BIN)) return env.BUN_BIN;
	for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir && executable(join(dir, 'bun'))) return join(dir, 'bun');
	const mise = spawnSync('mise', ['which', 'bun'], { cwd: ROOT, encoding: 'utf8' });
	const p = mise.status === 0 ? mise.stdout.trim() : '';
	return p && executable(p) ? p : null;
}

type LiveRun = { id: string; state: string; pid?: number };

/** The newest live run in the local D1 (read-only), null when there is none, or 'busy' when a run's writes kept it locked. */
async function liveRun(): Promise<LiveRun | null | 'busy'> {
	let file: string | undefined;
	try {
		file = readdirSync(D1_DIR).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
	} catch {
		return null;
	}
	if (!file) return null;
	const { DatabaseSync } = await import('node:sqlite');
	let db: InstanceType<typeof DatabaseSync>;
	try {
		db = new DatabaseSync(join(D1_DIR, file), { readOnly: true, timeout: BUSY_TIMEOUT_MS });
	} catch (e) {
		return LOCKED.test(String(e)) ? 'busy' : null;
	}
	try {
		const rows = db
			.prepare(
				`SELECT id, state, options, updated_at FROM render_runs WHERE state IN (${LIVE_STATES.map(() => '?').join(', ')}) ORDER BY started_at DESC LIMIT 5`
			)
			.all(...LIVE_STATES) as { id: string; state: string; options: string; updated_at: number }[];
		for (const r of rows) {
			if (Date.now() - r.updated_at > RENDER_STALE_MS) continue;
			let pid: number | undefined;
			try {
				pid = (JSON.parse(r.options) as { pid?: number }).pid;
			} catch {
				pid = undefined;
			}
			return { id: r.id, state: r.state, pid };
		}
		return null;
	} catch (e) {
		if (LOCKED.test(e instanceof Error ? e.message : String(e))) return 'busy';
		// No render tables yet (migrations not applied).
		return null;
	} finally {
		db.close();
	}
}

/**
 * The update (`bun run sync`) running now, from the same file, or null. Its steps pull the clone,
 * refresh the top N and start a render run themselves, so this panel's do neither meanwhile.
 */
async function liveSync(): Promise<{ id: string } | null | 'busy'> {
	const file = (() => {
		try {
			return readdirSync(D1_DIR).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
		} catch {
			return undefined;
		}
	})();
	if (!file) return null;
	const { DatabaseSync } = await import('node:sqlite');
	try {
		const db = new DatabaseSync(join(D1_DIR, file), { readOnly: true, timeout: BUSY_TIMEOUT_MS });
		try {
			return (
				(db.prepare(`SELECT id FROM sync_runs WHERE ${LIVE_SYNC_WHERE} LIMIT 1`).get(...liveSyncParams()) as { id: string } | undefined) ??
				null
			);
		} finally {
			db.close();
		}
	} catch (e) {
		// Busy, or no sync tables yet (migration 0020 not applied).
		return LOCKED.test(e instanceof Error ? e.message : String(e)) ? 'busy' : null;
	}
}

/** A 409/503 answer when an update is running (or the database is too busy to say), else null. */
const syncRefusal = async (what: string): Promise<[number, string] | null> => {
	const sync = await liveSync();
	if (sync === 'busy') return [503, 'the local database is busy (a run is writing to it); try again in a moment'];
	return sync ? [409, `an update is running (${sync.id}): ${what} once it ends, or stop it on the Overview`] : null;
};

const latestLog = () => {
	try {
		return (
			readdirSync(LOG_DIR)
				.filter((f) => LOG_NAME.test(f))
				.sort()
				.at(-1) ?? null
		);
	} catch {
		return null;
	}
};

const tail = (file: string, lines: number) => {
	const text = readFileSync(join(LOG_DIR, file), 'utf8');
	// Long runs write a lot; the end is what matters.
	return text.slice(-200_000).split('\n').slice(-lines).join('\n');
};

export function renderControl(): Plugin {
	let env: Record<string, string> = {};
	const children = new Set<ChildProcess>();

	const config = () => {
		const cloneDir = env.RENDER_CLONE_DIR || process.env.RENDER_CLONE_DIR || join(homedir(), 'data', 'factorio-mirror');
		const assetsDir = env.FPSR_ASSETS_DIR || process.env.FPSR_ASSETS_DIR || defaultAssets() || '';
		const r2 = !!(env.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID) && !!(env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY);
		const problems: string[] = [];
		if (!existsSync(cloneDir)) problems.push(`no mirror clone at ${cloneDir} (set RENDER_CLONE_DIR in .env)`);
		if (!assetsDir) problems.push('FPSR_ASSETS_DIR is not set (in .env or the environment of `bun run dev`)');
		else if (!existsSync(join(assetsDir, 'manifest.json'))) problems.push(`FPSR_ASSETS_DIR=${assetsDir} has no manifest.json`);
		return { cloneDir, assetsDir, r2, problems };
	};

	/** One top, check or pull at a time. */
	let scopeBusy: string | null = null;

	async function scope(kind: 'top' | 'check' | 'pull', req: IncomingMessage, res: ServerResponse) {
		const got = await jsonBody(req, res);
		if (!got) return;
		if (scopeBusy) return json(res, 409, { error: `a ${scopeBusy} is already running` });
		const refused = await syncRefusal(kind === 'pull' ? 'pull' : kind === 'top' ? 'refresh the top list' : 'check');
		if (refused) return json(res, refused[0], { error: refused[1] });
		const c = config();
		if (!existsSync(c.cloneDir)) return json(res, 409, { error: `no mirror clone at ${c.cloneDir} (set RENDER_CLONE_DIR in .env)` });
		if (kind === 'pull') {
			if (got.body && typeof got.body === 'object' && Object.keys(got.body).length)
				return json(res, 400, { error: 'pull takes no fields' });
			// A run reads records from the clone as it goes: a pull under it would change them mid-run.
			const live = await liveRun();
			if (live === 'busy') return json(res, 503, { error: 'the local database is busy (a run is writing to it); try again in a moment' });
			if (live) return json(res, 409, { error: `a render run is live (${live.id}, ${live.state}): stop it before pulling the clone` });
		}
		const argv = kind === 'pull' ? null : scopeArgs(kind, got.body, c.cloneDir);
		if (typeof argv === 'string') return json(res, 400, { error: argv });
		const bun = kind === 'pull' ? null : findBun(env);
		if (kind !== 'pull' && !bun) return json(res, 500, { error: 'bun not found: put it on PATH or set BUN_BIN' });
		scopeBusy = kind;
		try {
			const r =
				kind === 'pull'
					? await runToEnd('git', ['-C', c.cloneDir, 'pull', '--ff-only'], process.env, 300_000)
					: await runToEnd(bun!, ['scripts/render-scope.ts', ...argv!], { ...process.env, FORCE_COLOR: '0' }, 300_000);
			if (r.code !== 0)
				return json(res, 500, { error: (r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n') || `exit code ${r.code}` });
			if (kind === 'pull') return json(res, 200, { ok: true, output: r.stdout.trim().split('\n').slice(-6).join('\n') });
			const last = r.stdout.trim().split('\n').at(-1) ?? '';
			try {
				return json(res, 200, { ok: true, result: JSON.parse(last) as unknown });
			} catch {
				return json(res, 200, { ok: true, output: last });
			}
		} finally {
			scopeBusy = null;
		}
	}

	async function start(req: IncomingMessage, res: ServerResponse) {
		const got = await jsonBody(req, res);
		if (!got) return;
		const body = got.body;
		const c = config();
		const argv = startArgs(body, c.cloneDir);
		if (typeof argv === 'string') return json(res, 400, { error: argv });
		if (argv[0] !== '--resume' && c.problems.length) return json(res, 409, { error: c.problems.join('; ') });
		if (argv.includes('prod') && !c.r2) {
			return json(res, 409, {
				error: 'uploading to prod needs R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in .env (docs/deploy.md, "Uploading renders")'
			});
		}
		const live = await liveRun();
		if (live === 'busy') return json(res, 503, { error: 'the local database is busy (a run is writing to it); try again in a moment' });
		if (live)
			return json(res, 409, { error: `a render run is live (${live.id}, ${live.state}): pause or stop it first, or wait for it to end` });
		const refused = await syncRefusal('start a run');
		if (refused) return json(res, refused[0], { error: refused[1] });
		const bun = findBun(env);
		if (!bun) return json(res, 500, { error: 'bun not found: put it on PATH or set BUN_BIN' });

		mkdirSync(LOG_DIR, { recursive: true });
		const log = `render-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
		const fd = openSync(join(LOG_DIR, log), 'a');
		let child: ChildProcess;
		try {
			child = spawn(bun, ['scripts/render-game.ts', ...argv], {
				cwd: ROOT,
				detached: true,
				stdio: ['ignore', fd, fd],
				env: { ...process.env, ...(c.assetsDir ? { FPSR_ASSETS_DIR: c.assetsDir } : {}), FORCE_COLOR: '0' }
			});
		} finally {
			closeSync(fd);
		}
		children.add(child);
		child.unref();
		// A run that can't start (bad flags, nothing to resume, wrong credentials) exits within a few seconds: say so.
		const exited = await new Promise<number | null | undefined>((resolve) => {
			const timer = setTimeout(() => resolve(undefined), 4000);
			child.once('exit', (code) => {
				clearTimeout(timer);
				resolve(code);
			});
			child.once('error', () => {
				clearTimeout(timer);
				resolve(-1);
			});
		});
		if (exited !== undefined) {
			children.delete(child);
			return json(res, 500, { error: `the run exited at once (code ${exited})`, log, tail: tail(log, 40) });
		}
		child.once('exit', () => children.delete(child));
		return json(res, 200, { ok: true, pid: child.pid, log, command: `bun scripts/render-game.ts ${argv.join(' ')}` });
	}

	return {
		name: 'render-control',
		apply: 'serve',
		configResolved(c) {
			env = loadEnv(c.mode, c.root, '');
			// `bun run dev` doesn't pass .env to Vite, so hand RENDERS_DIR and THUMBS_DIR on: the dev site's
			// render route (lib/server/dev-files.ts) and the runs started here read process.env.
			if (env.RENDERS_DIR && !process.env.RENDERS_DIR) process.env.RENDERS_DIR = env.RENDERS_DIR;
			if (env.THUMBS_DIR && !process.env.THUMBS_DIR) process.env.THUMBS_DIR = env.THUMBS_DIR;
			LOG_DIR = join(rendersDir(ROOT), 'logs');
		},
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				const url = new URL(req.url ?? '/', 'http://localhost');
				if (!url.pathname.startsWith('/admin/render/__control/')) return next();
				try {
					if (url.pathname === '/admin/render/__control/status' && req.method === 'GET') {
						const c = config();
						const live = await liveRun();
						return json(res, 200, {
							cloneDir: c.cloneDir,
							assetsDir: c.assetsDir || null,
							problems: c.problems,
							prodReady: c.r2,
							live: live === 'busy' ? null : live,
							busy: live === 'busy',
							log: latestLog(),
							logDir: LOG_DIR,
							scopeBusy
						});
					}
					if (url.pathname === '/admin/render/__control/start' && req.method === 'POST') return await start(req, res);
					for (const kind of ['top', 'check', 'pull'] as const)
						if (url.pathname === `/admin/render/__control/${kind}` && req.method === 'POST') return await scope(kind, req, res);
					if (url.pathname === '/admin/render/__control/log' && req.method === 'GET') {
						const name = url.searchParams.get('file') ?? latestLog();
						if (!name || !LOG_NAME.test(name) || !existsSync(join(LOG_DIR, name))) return json(res, 404, { error: 'no log' });
						const lines = Math.min(500, Math.max(1, Number(url.searchParams.get('lines')) || 80));
						return json(res, 200, { log: name, tail: tail(name, lines) });
					}
					return json(res, 404, { error: 'not found' });
				} catch (e) {
					return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
				}
			});
		}
	};
}
