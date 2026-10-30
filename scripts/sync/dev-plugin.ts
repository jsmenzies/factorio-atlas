/**
 * The admin Update and Overview tabs' buttons under `vite dev`: SvelteKit's server code runs in workerd and can't
 * start processes, so this Vite plugin answers the paths below before SvelteKit sees them (like
 * scripts/render/dev-plugin.ts, whose request helpers it shares). Deployed, they are ordinary 404s.
 *
 *   POST /admin/__sync/plan      {}: `bun scripts/sync.ts --plan --json` (fetch the mirror, say what
 *                                an update would do); waits for it
 *   POST /admin/__sync/figures   {}: `bun scripts/sync.ts --figures --stage prod --json`; waits
 *   POST /admin/__sync/top-preview {"n": N}: `bun scripts/sync.ts --top-preview N` (what a top N would
 *                                add to the render scope, for the Update tab's render step); waits
 *   POST /admin/__sync/start     {"stage"?: "prod"|"local"}: starts `bun scripts/sync.ts --stage S --yes`
 *                                detached, so the update outlives a dev server restart
 *   GET  /admin/__sync/log       `?file=sync-….log&lines=N[&progress=1]`: the end of an update's log, and with
 *                                `progress` the current step's live counts from it (#lib/sync-progress.js)
 *
 * Stop is the page's own form action (it sets sync_runs.control). The update writes its own log;
 * what it prints goes to <logs>/sync-console.log, read back when it exits at once.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, type Plugin } from 'vite';
import { rendersDir } from '#lib/server/renders-dir.js';
import { findBun, json, jsonBody, runToEnd } from '../render/dev-plugin.js';
import { logProgress } from '#lib/sync-progress.js';
import { lastJsonLine } from './output.js';

const ROOT = join(import.meta.dirname, '..', '..');
const LOG_NAME = /^sync-[0-9TZ-]+\.log$/;
const CONSOLE_LOG = 'sync-console.log';

const tail = (file: string, lines: number) => readFileSync(file, 'utf8').slice(-200_000).split('\n').slice(-lines).join('\n');

const errorOf = (r: { code: number | null; stdout: string; stderr: string }) =>
	(r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n') || `exit code ${r.code}`;

export function syncControl(): Plugin {
	let env: Record<string, string> = {};
	let logDir = join(rendersDir(ROOT), 'logs');
	/** One plan or figures read at a time (a top preview is quick and read-only, so it never waits). */
	let waiting: string | null = null;

	/** Run sync.ts in one of its quick modes and answer with the JSON it prints last. */
	async function quick(kind: 'plan' | 'figures' | 'top-preview', req: Parameters<typeof jsonBody>[0], res: Parameters<typeof json>[0]) {
		const got = await jsonBody(req, res);
		if (!got) return;
		const body = (got.body ?? {}) as Record<string, unknown>;
		const allowed = kind === 'top-preview' ? ['n'] : [];
		const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
		if (unknown.length) return json(res, 400, { error: `unknown field: ${unknown.join(', ')}` });
		const n = body.n;
		if (kind === 'top-preview' && !(typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 100_000))
			return json(res, 400, { error: '"n" must be a whole number from 0 to 100000' });
		if (kind !== 'top-preview' && waiting) return json(res, 409, { error: `already reading the ${waiting}` });
		const bun = findBun(env);
		if (!bun) return json(res, 500, { error: 'bun not found: put it on PATH or set BUN_BIN' });
		if (kind !== 'top-preview') waiting = kind;
		try {
			const args =
				kind === 'plan'
					? ['--plan', '--json']
					: kind === 'figures'
						? ['--figures', '--stage', 'prod', '--json']
						: ['--top-preview', String(n)];
			const r = await runToEnd(bun, ['scripts/sync.ts', ...args], { ...process.env, FORCE_COLOR: '0' }, 180_000);
			const result = lastJsonLine(r.stdout);
			if (r.code !== 0 || !result) return json(res, 500, { error: errorOf(r) });
			return json(res, 200, { ok: true, result });
		} finally {
			if (kind !== 'top-preview') waiting = null;
		}
	}

	async function start(req: Parameters<typeof jsonBody>[0], res: Parameters<typeof json>[0]) {
		const got = await jsonBody(req, res);
		if (!got) return;
		const body = (got.body ?? {}) as Record<string, unknown>;
		const unknown = Object.keys(body).filter((k) => k !== 'stage');
		if (unknown.length) return json(res, 400, { error: `unknown field: ${unknown.join(', ')}` });
		const stage = body.stage ?? 'prod';
		if (stage !== 'prod' && stage !== 'local') return json(res, 400, { error: '"stage" must be "prod" or "local"' });
		const bun = findBun(env);
		if (!bun) return json(res, 500, { error: 'bun not found: put it on PATH or set BUN_BIN' });
		mkdirSync(logDir, { recursive: true });
		const consoleLog = join(logDir, CONSOLE_LOG);
		// Only the latest start's console: each update has its own log beside it.
		const fd = openSync(consoleLog, 'w');
		let child: ChildProcess;
		try {
			// The update checks for a live update or render run itself, and refuses.
			child = spawn(bun, ['scripts/sync.ts', '--stage', stage, '--yes'], {
				cwd: ROOT,
				detached: true,
				stdio: ['ignore', fd, fd],
				env: { ...process.env, FORCE_COLOR: '0' }
			});
		} finally {
			closeSync(fd);
		}
		child.unref();
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
		if (exited !== undefined)
			return json(res, 409, { error: tail(consoleLog, 6).trim().split('\n').at(-1) || `the update exited at once (code ${exited})` });
		return json(res, 200, { ok: true, pid: child.pid });
	}

	return {
		name: 'sync-control',
		apply: 'serve',
		configResolved(c) {
			env = loadEnv(c.mode, c.root, '');
			logDir = join(rendersDir(ROOT, env.RENDERS_DIR || process.env.RENDERS_DIR), 'logs');
		},
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				const url = new URL(req.url ?? '/', 'http://localhost');
				if (!url.pathname.startsWith('/admin/__sync/')) return next();
				try {
					if (req.method === 'POST' && url.pathname === '/admin/__sync/plan') return await quick('plan', req, res);
					if (req.method === 'POST' && url.pathname === '/admin/__sync/figures') return await quick('figures', req, res);
					if (req.method === 'POST' && url.pathname === '/admin/__sync/top-preview') return await quick('top-preview', req, res);
					if (req.method === 'POST' && url.pathname === '/admin/__sync/start') return await start(req, res);
					if (req.method === 'GET' && url.pathname === '/admin/__sync/log') {
						const name = url.searchParams.get('file') ?? '';
						if (!LOG_NAME.test(name) || !existsSync(join(logDir, name))) return json(res, 404, { error: 'no such log' });
						const lines = Math.min(200, Math.max(1, Number(url.searchParams.get('lines')) || 20));
						const file = join(logDir, name);
						// The current step's part of the log, for its live counts: its last 4 MB hold it (a render step's
						// per-page lines are the longest part, and it needs none of them).
						const progress =
							url.searchParams.get('progress') === '1' ? logProgress(readFileSync(file, 'utf8').slice(-4_000_000)) : undefined;
						return json(res, 200, { log: name, tail: tail(file, lines), ...(progress ? { progress } : {}) });
					}
					return json(res, 404, { error: 'not found' });
				} catch (e) {
					return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
				}
			});
		}
	};
}
