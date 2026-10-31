import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { attachShared, boundGeneration, openRemoteTarget, SHARED_STAGE_ENV, sharedStage, type SharedStage } from './stage';
import { connectRemote, pingRemote } from './remote';

/** A stand-in for remote-bindings.mjs: answers /d1 as a stage with the latest tables would, counting requests. */
const TOKEN = 'test-token';
let server: Server;
let port = 0;
let requests: string[] = [];
let healthy = true;

const send = (res: ServerResponse, status: number, body: unknown) => {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
};

beforeAll(async () => {
	server = createServer(async (req, res) => {
		if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { op: string; sql: string };
		requests.push(body.sql);
		if (!healthy) return send(res, 500, { error: 'session expired' });
		if (body.sql === 'SELECT 1 AS ok') return send(res, 200, { row: { ok: 1 } });
		if (body.sql.includes('sqlite_master'))
			return send(res, 200, {
				results: ['pipeline_runs', 'ingest_state', 'prints', 'print_renders', 'authors', 'removal_blocks'].map((name) => ({ name })),
				success: true,
				meta: {}
			});
		send(res, 200, { row: { answer: 42 } });
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const shared = (over: Partial<SharedStage> = {}): SharedStage => ({
	stage: 'prod',
	generation: boundGeneration('prod'),
	port: port,
	token: TOKEN,
	pid: process.pid,
	database: 'factorio-prints-prod-db-2 (uuid)',
	bucket: 'factorio-prints-prod-raw',
	...over
});
const environ = (s: unknown) => ({ [SHARED_STAGE_ENV]: typeof s === 'string' ? s : JSON.stringify(s) });

describe('sharedStage', () => {
	const gen = boundGeneration('prod');
	test("an update's stage, for the same stage and D1 generation, while its sidecar runs", () => {
		expect(sharedStage(environ(shared()), 'prod', gen)).toEqual(shared());
	});
	test('none without the variable, for another stage or generation, a dead sidecar, or a malformed value', () => {
		expect(sharedStage({}, 'prod', gen)).toBeNull();
		expect(sharedStage(environ(shared()), 'local', gen)).toBeNull();
		expect(sharedStage(environ(shared()), 'prod', gen + 1)).toBeNull();
		expect(sharedStage(environ(shared()), 'prod', gen, () => false)).toBeNull();
		expect(sharedStage(environ('{not json'), 'prod', gen)).toBeNull();
		expect(sharedStage(environ({ ...shared(), token: undefined }), 'prod', gen)).toBeNull();
		expect(sharedStage(environ({ ...shared(), port: '1234' }), 'prod', gen)).toBeNull();
	});
});

describe('attaching to a shared sidecar', () => {
	test('a healthy one: the bindings reach it, and dispose leaves it running', async () => {
		requests = [];
		healthy = true;
		const lines: string[] = [];
		const target = await attachShared(shared(), (l) => lines.push(l));
		expect(target).not.toBeNull();
		expect(target!.database).toBe('factorio-prints-prod-db-2 (uuid)');
		expect(target!.bucket).toBe('factorio-prints-prod-raw');
		expect(await target!.env.DB.prepare('SELECT answer').first()).toEqual({ answer: 42 });
		await target!.dispose();
		expect(await pingRemote(port, TOKEN)).toBe(true);
		// The health check, the schema check, the query, then the ping above.
		expect(requests.length).toBe(4);
		expect(lines).toEqual([]);
	});

	test("one that doesn't answer: null, so the caller opens its own, and it says so", async () => {
		healthy = false;
		const lines: string[] = [];
		expect(await attachShared(shared(), (l) => lines.push(l))).toBeNull();
		expect(lines[0]).toContain("didn't answer: opening a new one");
		healthy = true;
	});

	test('one whose port is gone, or that refuses the token: not healthy', async () => {
		expect(await pingRemote(1, TOKEN, 2000)).toBe(false);
		expect(await pingRemote(port, 'wrong', 2000)).toBe(false);
	});

	describe('openRemoteTarget (never a real open: `open` is a stand-in)', () => {
		const gen = boundGeneration('prod');
		const opened: string[] = [];
		const deps = {
			attach: (sh: SharedStage, log: (line: string) => void) => attachShared(sh, log),
			open: async (stage: 'prod', generation: number) => {
				opened.push(`${stage}@${generation}`);
				return { stage, database: 'own', bucket: 'own', env: {} as never, dispose: async () => undefined };
			}
		};

		test('attaches when the variable names this stage, without opening its own', async () => {
			opened.length = 0;
			requests = [];
			const target = await openRemoteTarget('prod', gen, () => undefined, deps, environ(shared()));
			expect(target.database).toBe(shared().database);
			expect(requests[0]).toBe('SELECT 1 AS ok');
			await target.dispose();
			expect(await pingRemote(port, TOKEN)).toBe(true);
			expect(opened).toEqual([]);
		});

		test("opens its own when the shared one doesn't answer, or there is none, or it is another generation's", async () => {
			opened.length = 0;
			healthy = false;
			expect((await openRemoteTarget('prod', gen, () => undefined, deps, environ(shared()))).database).toBe('own');
			healthy = true;
			expect((await openRemoteTarget('prod', gen, () => undefined, deps, {})).database).toBe('own');
			expect((await openRemoteTarget('prod', gen + 1, () => undefined, deps, environ(shared()))).database).toBe('own');
			expect(opened).toEqual([`prod@${gen}`, `prod@${gen}`, `prod@${gen + 1}`]);
		});
	});

	test("the shims' errors read as before", async () => {
		healthy = false;
		const { DB } = connectRemote(port, TOKEN);
		await expect(DB.prepare('SELECT 1').all()).rejects.toThrow('remote /d1: session expired');
		healthy = true;
	});
});
