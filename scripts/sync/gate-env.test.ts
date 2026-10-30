import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { d1FromSqlite } from '#lib/server/pipeline/d1-sqlite.js';
import { purgePrintData } from '#lib/server/takedown.js';
import type { RenderStore } from '../render/store';
import { deployedGateEnv, PROBE_PREFIX, probeBuckets } from './gate-env';

const ROOT = join(import.meta.dirname, '..', '..');

/** The backfill's remote RAW as it is: get, put, list of one page, and delete of one key per call (an array would be one bad key). */
const remoteRaw = (objects: Map<string, string>, calls: string[]) =>
	({
		get: async (k: string) => (objects.has(k) ? { text: async () => objects.get(k)! } : null),
		put: async (k: string, v: string) => void objects.set(k, v),
		delete: async (k: unknown) => {
			if (typeof k !== 'string') throw new Error('the remote RAW deletes one key per call');
			calls.push(`raw delete ${k}`);
			objects.delete(k);
		},
		list: async (o: R2ListOptions) => {
			calls.push(`raw list ${o.prefix}`);
			return { objects: [...objects.keys()].filter((k) => k.startsWith(o.prefix ?? '')).map((key) => ({ key })), truncated: false };
		}
	}) as unknown as R2Bucket;

/** S3 stores per bucket, over in-memory objects. */
const stores = (buckets: Map<string, Map<string, string>>, calls: string[]) => (bucket: string) => {
	const objects = buckets.get(bucket) ?? new Map<string, string>();
	buckets.set(bucket, objects);
	return {
		label: bucket,
		put: async (key: string) => void objects.set(key, ''),
		delete: async (key: string) => {
			calls.push(`${bucket} delete ${key}`);
			objects.delete(key);
		},
		list: async (prefix: string) => {
			calls.push(`${bucket} list ${prefix}`);
			return [...objects.keys()].filter((k) => k.startsWith(prefix));
		}
	} as unknown as RenderStore;
};

const ALL = { R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret', CACHE_PURGE_TOKEN: 'token', CACHE_ZONE_ID: 'zone' };

describe('a deployed stage gate for Bun', () => {
	test('purging needs the R2 keys, the purge token and the zone id; it says which are missing', () => {
		const remote = { DB: {} as D1Database, RAW: remoteRaw(new Map(), []) };
		const make = (environ: Record<string, string>) => deployedGateEnv('prod', 1, remote, {}, environ, stores(new Map(), []));
		expect(make(ALL)).toMatchObject({ canPurge: true, missing: [] });
		expect(make({ ...ALL, CACHE_ZONE_ID: '' })).toMatchObject({ canPurge: false, missing: ['CACHE_ZONE_ID'] });
		expect(make({}).missing).toEqual(['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'CACHE_PURGE_TOKEN', 'CACHE_ZONE_ID']);
	});

	test("a purge through it deletes the print's rows, every RAW key and listing, and its renders", async () => {
		const sqlite = new Database(':memory:');
		for (const f of readdirSync(join(ROOT, 'migrations'))
			.filter((f) => f.endsWith('.sql'))
			.sort())
			sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
		sqlite.run(
			`INSERT INTO prints (id, source, source_url, title, raw_key, raw_sha256, ingested_at, analyzer_version, root_kind,
				blueprint_count, entity_count, requires_space_age, uses_circuits, uses_trains)
			VALUES ('codex-5', 'codex', 'u', 't', 'codex/5.json', 's', 1, 1, 'blueprint', 1, 1, 0, 0, 0)`
		);
		const rawObjects = new Map([
			['analysis/codex-5.json', '{}'],
			['codex/5.json', '{}'],
			['viewer/codex-5/index.json', '{}'],
			['viewer/codex-5/0.txt', 'x']
		]);
		const calls: string[] = [];
		const buckets = new Map([
			['factorio-prints-prod-raw', rawObjects],
			['factorio-prints-prod-renders', new Map([['codex-5/index.json', '{}']])]
		]);
		const { env } = deployedGateEnv(
			'prod',
			1,
			{ DB: d1FromSqlite(sqlite), RAW: remoteRaw(rawObjects, calls) },
			{},
			{ ...ALL, RENDERS_DOMAIN_PROD: '' },
			stores(buckets, calls)
		);
		const r = await purgePrintData(env, 'codex-5', { kind: 'gone' });
		expect(sqlite.query(`SELECT 1 FROM prints WHERE id = 'codex-5'`).get()).toBeNull();
		expect(sqlite.query(`SELECT kind FROM print_tombstones WHERE print_id = 'codex-5'`).get()).toEqual({ kind: 'gone' });
		expect([...rawObjects.keys()]).toEqual([]);
		expect(calls).toContain('raw list viewer/codex-5/');
		expect(calls).toContain('factorio-prints-prod-renders delete codex-5/index.json');
		expect(r.renderObjects).toBe(1);
	});

	test('without the R2 keys a purge fails loudly rather than leaving files', async () => {
		const { env } = deployedGateEnv('prod', 1, { DB: {} as D1Database, RAW: remoteRaw(new Map(), []) }, {}, {}, stores(new Map(), []));
		await expect(env.RENDERS.list({ prefix: 'x/' })).rejects.toThrow('R2_ACCESS_KEY_ID');
		await expect(env.SCREENSHOTS.list({ prefix: 'x/' })).rejects.toThrow('R2_ACCESS_KEY_ID');
	});

	test('the access probe lists an empty prefix of each bucket and names those that refuse', async () => {
		const calls: string[] = [];
		const ok = remoteRaw(new Map(), calls);
		const refusing = { list: async () => Promise.reject(new Error('HTTP 403 AccessDenied\nmore')) } as unknown as R2Bucket;
		expect(await probeBuckets({ raw: ok, renders: refusing, screenshots: ok })).toEqual(['list access to renders (HTTP 403 AccessDenied)']);
		expect(calls).toEqual([`raw list ${PROBE_PREFIX}`, `raw list ${PROBE_PREFIX}`]);
	});
});
