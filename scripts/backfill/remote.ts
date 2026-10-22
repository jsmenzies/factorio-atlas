/**
 * Remote D1 and R2 for a deployed stage (prod), through the Node sidecar in remote-bindings.mjs (why: see there).
 * The shims implement only what the pipeline and runs.ts use: `prepare().bind().first/all/run`,
 * `batch`, and R2 `put`/`get().text()`/`delete` with string bodies.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** One remote call; a hung request fails instead of stalling a print forever. */
const REQUEST_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 90_000;

export interface RemoteBindings {
	readonly DB: D1Database;
	readonly RAW: R2Bucket;
	readonly dispose: () => Promise<void>;
}

type Params = unknown[];

export const openRemoteBindings = async (configPath: string, log: (line: string) => void): Promise<RemoteBindings> => {
	const token = randomBytes(24).toString('hex');
	const child = spawn('node', [join(import.meta.dirname, 'remote-bindings.mjs'), configPath], {
		cwd: join(import.meta.dirname, '..', '..'),
		env: { ...process.env, BACKFILL_SIDECAR_TOKEN: token },
		stdio: ['pipe', 'pipe', 'pipe']
	});
	const recent: string[] = [];
	let ready = false;
	const remember = (line: string) => {
		recent.push(line);
		if (recent.length > 20) recent.shift();
		// wrangler's own progress lines ("Establishing remote connection...") until the bindings work.
		if (!ready && line.trim()) log(`  ${line}`);
	};
	createInterface({ input: child.stderr! }).on('line', remember);
	const port = await new Promise<number>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`remote bindings didn't start in ${START_TIMEOUT_MS / 1000} s:\n${recent.join('\n')}`)),
			START_TIMEOUT_MS
		);
		child.once('error', (e) =>
			reject(new Error(`couldn't start node for remote bindings (${e.message}); Node ≥ 20 must be on PATH (mise.toml installs it)`))
		);
		child.once('exit', (code) => reject(new Error(`remote bindings exited (${code}):\n${recent.join('\n')}`)));
		createInterface({ input: child.stdout! }).on('line', (line) => {
			const m = /^READY (\d+)$/.exec(line);
			if (m) {
				clearTimeout(timer);
				ready = true;
				resolve(Number(m[1]));
			} else remember(line);
		});
	});
	let disposing = false;
	child.once('exit', (code) => {
		if (!disposing) log(`! remote bindings exited (${code}); remaining D1/R2 calls will fail:\n${recent.join('\n')}`);
	});
	const base = `http://127.0.0.1:${port}`;
	const headers = { authorization: `Bearer ${token}` };

	const call = async (path: string, init: RequestInit = {}) => {
		const res = await fetch(`${base}${path}`, {
			...init,
			headers: { ...headers, ...init.headers },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
		if (res.ok || res.status === 404) return res;
		const text = await res.text();
		let message = text;
		try {
			message = (JSON.parse(text) as { error?: string }).error ?? text;
		} catch {
			// not JSON
		}
		throw new Error(`remote ${path.split('?')[0]}: ${message}`);
	};
	const d1 = async <T>(body: unknown): Promise<T> =>
		(
			await call('/d1', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
		).json() as Promise<T>;

	class Statement {
		constructor(
			readonly sql: string,
			readonly params: Params = []
		) {}
		bind(...params: Params) {
			return new Statement(this.sql, params);
		}
		async first<T>(): Promise<T | null> {
			return (await d1<{ row: T | null }>({ op: 'first', sql: this.sql, params: this.params })).row;
		}
		all<T>() {
			return d1<D1Result<T>>({ op: 'all', sql: this.sql, params: this.params });
		}
		run() {
			return d1<D1Result>({ op: 'run', sql: this.sql, params: this.params });
		}
	}
	const DB = {
		prepare: (sql: string) => new Statement(sql),
		batch: (statements: Statement[]) =>
			d1<D1Result[]>({ op: 'batch', statements: statements.map((s) => ({ sql: s.sql, params: s.params })) })
	} as unknown as D1Database;

	const key = (k: string) => `/r2?key=${encodeURIComponent(k)}`;
	const RAW = {
		put: async (k: string, body: string, options?: R2PutOptions) => {
			const contentType = (options?.httpMetadata as R2HTTPMetadata | undefined)?.contentType ?? 'application/json';
			await call(`${key(k)}&contentType=${encodeURIComponent(contentType)}`, { method: 'PUT', body });
			return null;
		},
		get: async (k: string) => {
			const res = await call(key(k));
			if (res.status === 404) return null;
			const text = await res.text();
			return { text: async () => text };
		},
		delete: async (k: string) => {
			await call(key(k), { method: 'DELETE' });
		}
	} as unknown as R2Bucket;

	const dispose = async () => {
		disposing = true;
		if (child.exitCode !== null) return;
		const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
		child.kill('SIGTERM');
		await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 8000))]);
		if (child.exitCode === null) child.kill('SIGKILL');
	};
	return { DB, RAW, dispose };
};
