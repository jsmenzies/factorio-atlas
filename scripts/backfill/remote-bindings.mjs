/**
 * Node sidecar that holds wrangler's remote bindings (D1 + R2) for `bun run backfill --stage prod`
 * and serves them to the Bun parent over loopback HTTP (scripts/backfill/remote.ts is the client).
 *
 * Why: under Bun, wrangler's remote proxy session never comes up. Its ProxyController talks to the
 * local ProxyWorker through undici with a custom dispatcher (`http://dummy/cdn-cgi/ProxyWorker/...`),
 * Bun's undici shim ignores the dispatcher, and every message fails with `getaddrinfo ENOTFOUND
 * dummy`, so `getPlatformProxy` hangs at "Establishing remote connection...". Under Node the same
 * config connects in about 3 s.
 *
 *   node scripts/backfill/remote-bindings.mjs <wrangler config>   (env BACKFILL_SIDECAR_TOKEN)
 *
 * Prints `READY <port>` once the bindings work, then answers POST /d1 and GET (the bytes)|PUT|DELETE /r2?key=…,
 * each with `authorization: Bearer <token>`. Exits when stdin closes (the parent died) or on SIGTERM.
 * Plain JavaScript so Node runs it without a build step.
 */
import { createServer } from 'node:http';
import { getPlatformProxy } from 'wrangler';

const configPath = process.argv[2];
const token = process.env.BACKFILL_SIDECAR_TOKEN;
if (!configPath || !token) {
	console.error('usage: BACKFILL_SIDECAR_TOKEN=… node remote-bindings.mjs <wrangler config>');
	process.exit(2);
}

/** @type {import('wrangler').PlatformProxy<{ DB: D1Database; RAW: R2Bucket }>} */
const proxy = await getPlatformProxy({ configPath, persist: false, envFiles: [], remoteBindings: true });
const { DB, RAW } = proxy.env;

let closing = false;
const shutdown = async () => {
	if (closing) return;
	closing = true;
	await Promise.race([proxy.dispose(), new Promise((r) => setTimeout(r, 5000))]);
	process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.stdin.resume();

/** @param {import('node:http').IncomingMessage} req */
const readBody = async (req) => {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	return Buffer.concat(chunks).toString('utf8');
};

/** @typedef {{ sql: string; params?: unknown[] }} Sql */

/** @param {Sql} s */
const statement = ({ sql, params }) => DB.prepare(sql).bind(...(params ?? []));

/**
 * D1: {op: first|all|run, sql, params} or {op: batch, statements: [{sql, params}]}.
 * @param {{ op: string; sql: string; params?: unknown[]; statements: Sql[] }} request
 */
const d1 = async ({ op, sql, params, statements }) => {
	if (op === 'batch') return DB.batch(statements.map(statement));
	const stmt = statement({ sql, params });
	if (op === 'first') return { row: (await stmt.first()) ?? null };
	if (op === 'all') return stmt.all();
	if (op === 'run') return stmt.run();
	throw new Error(`unknown op ${op}`);
};

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string | Buffer} body
 */
const send = (res, status, body, type = 'application/json') => {
	res.writeHead(status, { 'content-type': type });
	res.end(body);
};

const server = createServer(async (req, res) => {
	try {
		if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, '{"error":"unauthorized"}');
		const url = new URL(req.url ?? '/', 'http://localhost');
		if (url.pathname === '/d1' && req.method === 'POST') {
			return send(res, 200, JSON.stringify(await d1(JSON.parse(await readBody(req)))));
		}
		if (url.pathname === '/r2') {
			const key = url.searchParams.get('key');
			if (!key) return send(res, 400, '{"error":"key required"}');
			if (req.method === 'GET') {
				const object = await RAW.get(key);
				// The object's bytes as they are: text for records, images for the screenshots step.
				return object ? send(res, 200, Buffer.from(await object.arrayBuffer()), 'application/octet-stream') : send(res, 404, '');
			}
			if (req.method === 'PUT') {
				const contentType = url.searchParams.get('contentType') ?? 'application/json';
				await RAW.put(key, await readBody(req), { httpMetadata: { contentType } });
				return send(res, 200, '{}');
			}
			if (req.method === 'DELETE') {
				await RAW.delete(key);
				return send(res, 200, '{}');
			}
		}
		send(res, 404, '{"error":"not found"}');
	} catch (e) {
		send(res, 500, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
	}
});
server.keepAliveTimeout = 60_000;
server.listen(0, '127.0.0.1', () => {
	const address = server.address();
	console.log(`READY ${typeof address === 'object' && address ? address.port : 0}`);
});
