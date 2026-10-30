/**
 * /admin/add under `vite dev`: SvelteKit's server code runs in workerd and can't start processes, so this
 * Vite plugin answers the path below before SvelteKit sees it (like scripts/sync/dev-plugin.ts, whose
 * request helpers it shares). Deployed, it is an ordinary 404 and the page adds in the Worker instead.
 *
 *   POST /admin/__add   {"link": "https://factoriobin.com/post/<id>", "stage": "prod"|"local", "plan": bool}:
 *                       runs `bun scripts/add.ts <link> --stage S [--plan] --yes --json` (no size caps; the
 *                       print also goes into the record store) and answers its last JSON line (AddView,
 *                       src/lib/add-by-link.ts); waits for it. One at a time.
 *
 * Sending it is the consent to write to prod (`--yes`), as the Overview's update button is.
 */
import type { Plugin } from 'vite';
import { loadEnv } from 'vite';
import { parsePostLink, postUrl } from '#lib/factoriobin-link.js';
import { findBun, json, jsonBody, runToEnd } from '../render/dev-plugin.js';
import { lastJsonLine } from '../sync/output.js';

const errorOf = (r: { code: number | null; stdout: string; stderr: string }) =>
	(r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n') || `exit code ${r.code}`;

/** The command line for a request body, or why it can't be run. */
export function addArgs(body: unknown): string[] | string {
	const b = (body ?? {}) as Record<string, unknown>;
	const unknown = Object.keys(b).filter((k) => !['link', 'stage', 'plan'].includes(k));
	if (unknown.length) return `unknown field: ${unknown.join(', ')}`;
	if (typeof b.link !== 'string' || !parsePostLink(b.link)) return '"link" must be a factoriobin post link';
	const stage = b.stage ?? 'prod';
	if (stage !== 'prod' && stage !== 'local') return '"stage" must be "prod" or "local"';
	if (b.plan !== undefined && typeof b.plan !== 'boolean') return '"plan" must be true or false';
	// Rebuilt from the id and node, so nothing from the request reaches the command line but letters and digits.
	const { id, node } = parsePostLink(b.link)!;
	return [
		'scripts/add.ts',
		`${postUrl(id)}${node === null ? '' : `/${node}`}`,
		'--stage',
		stage,
		...(b.plan ? ['--plan'] : []),
		'--yes',
		'--json'
	];
}

export function addControl(): Plugin {
	let env: Record<string, string> = {};
	let busy = false;
	return {
		name: 'add-control',
		apply: 'serve',
		configResolved(c) {
			env = loadEnv(c.mode, c.root, '');
		},
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				const url = new URL(req.url ?? '/', 'http://localhost');
				if (url.pathname !== '/admin/__add') return next();
				if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
				try {
					const got = await jsonBody(req, res);
					if (!got) return;
					const args = addArgs(got.body);
					if (typeof args === 'string') return json(res, 400, { error: args });
					if (busy) return json(res, 409, { error: 'already adding a print; wait for it' });
					const bun = findBun(env);
					if (!bun) return json(res, 500, { error: 'bun not found: put it on PATH or set BUN_BIN' });
					busy = true;
					try {
						// RECORDS_DIR from .env: `bun run` passes it to scripts, Vite doesn't.
						const childEnv = { ...process.env, ...(env.RECORDS_DIR ? { RECORDS_DIR: env.RECORDS_DIR } : {}), FORCE_COLOR: '0' };
						const r = await runToEnd(bun, args, childEnv, 600_000);
						const view = lastJsonLine(r.stdout);
						if (!view) return json(res, 500, { error: errorOf(r) });
						return json(res, 200, { ok: true, view });
					} finally {
						busy = false;
					}
				} catch (e) {
					return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
				}
			});
		}
	};
}
