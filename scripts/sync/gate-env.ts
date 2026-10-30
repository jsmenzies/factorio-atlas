/**
 * The site's gate (src/lib/server/uploads/gate.ts `workerGate`: admit, ingest, hand-over and purge) on a
 * stage, for a Bun script that polls another site (scripts/polled.ts): the same bindings the site Worker
 * has. `local` is the miniflare state `bun run dev` serves, every binding included.
 *
 * A deployed stage's D1 and RAW come through the backfill's remote bindings (scripts/backfill/remote.ts),
 * whose RAW does only get, put and one-key delete. A purge (takedown.ts `purgePrintData`) also deletes
 * several RAW keys at once and lists `viewer/<id>/`, so RAW here is that binding for reads and writes,
 * one-key deletes for a list of keys, and R2's S3 API for listing. RENDERS and SCREENSHOTS, which a purge
 * lists and deletes from, are R2's S3 API too (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY, as render and
 * screenshot uploads use), and the edge purge needs CACHE_PURGE_TOKEN and CACHE_ZONE_ID (the zone of the
 * renders and screenshots domains). `canPurge` is false while any of these is missing (`missing` names
 * them): a deletion then waits rather than leaving files in the buckets or the edge cache.
 */
import { getPlatformProxy, unstable_readConfig } from 'wrangler';
import type { GateEnv } from '#lib/server/uploads/gate.js';
import { screenshotsBucket, type Stage as DeployedStage } from '../../infra/databases';
import { accountId, boundGeneration, openTarget, resourceNames, TargetError, type Stage } from '../backfill/stage';
import { s3Store, type RenderStore } from '../render/store';

export interface StageGate {
	env: GateEnv;
	/** What it reads and writes, for the status line. */
	label: string;
	/** Whether a purge can reach everything it deletes and the edge cache (`missing` says what it lacks). */
	canPurge: boolean;
	/** The environment variables a purge on this stage still needs. */
	missing: string[];
	dispose: () => Promise<void>;
}

/** The R2Bucket calls a purge makes (list, delete, put), over the render uploader's S3 store. */
export const storeBucket = (store: RenderStore): R2Bucket =>
	({
		list: async (o?: R2ListOptions) => ({
			objects: (await store.list(o?.prefix ?? '')).map((key) => ({ key })),
			truncated: false,
			delimitedPrefixes: []
		}),
		delete: async (keys: string | string[]) => {
			for (const key of [keys].flat()) await store.delete(key);
		},
		put: async (key: string, value: string | ArrayBuffer | Uint8Array, o?: R2PutOptions) => {
			const body = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value as ArrayBuffer);
			const meta = (o?.httpMetadata ?? {}) as R2HTTPMetadata;
			await store.put(key, body, meta.contentType ?? 'application/octet-stream', meta.cacheControl ?? 'no-store');
			return null;
		}
	}) as unknown as R2Bucket;

/** A bucket that refuses every call: a deployed stage without the R2 keys can't purge. */
const noBucket = (what: string): R2Bucket =>
	new Proxy({} as R2Bucket, {
		get: (_, prop) =>
			prop === 'then'
				? undefined
				: () => Promise.reject(new TargetError(`${what} needs R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (docs/deploy.md)`))
	});

/**
 * RAW for a Bun run on a deployed stage: the remote binding for get and put, a list of keys deleted one by
 * one through it (it takes one key per call), and listing through `lister` (R2's S3 API), else refused.
 */
export const rawBucket = (remote: R2Bucket, lister: R2Bucket | null): R2Bucket =>
	({
		get: (key: string) => remote.get(key),
		put: (key: string, value: string, o?: R2PutOptions) => remote.put(key, value, o),
		delete: async (keys: string | string[]) => {
			for (const key of [keys].flat()) await remote.delete(key);
		},
		list: (o?: R2ListOptions) =>
			lister
				? lister.list(o)
				: Promise.reject(new TargetError('listing RAW needs R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (docs/deploy.md)'))
	}) as unknown as R2Bucket;

const domainUrl = (v: string | undefined) => (v?.trim() ? `https://${v.trim()}` : '');

/**
 * A deployed stage's gate bindings from its remote D1 and RAW, the wrangler vars and the environment. Pure
 * apart from `store` (the S3 store of one bucket), for tests.
 */
export function deployedGateEnv(
	stage: DeployedStage,
	generation: number,
	remote: { DB: D1Database; RAW: R2Bucket },
	vars: Record<string, string>,
	environ: Record<string, string | undefined>,
	store: (bucket: string, keys: { accessKeyId: string; secretAccessKey: string }) => RenderStore
): { env: GateEnv; canPurge: boolean; missing: string[] } {
	const accessKeyId = environ.R2_ACCESS_KEY_ID?.trim();
	const secretAccessKey = environ.R2_SECRET_ACCESS_KEY?.trim();
	const keys = accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : null;
	const s3 = (bucket: string) => (keys ? storeBucket(store(bucket, keys)) : noBucket(bucket));
	const names = resourceNames(stage, generation);
	const env: GateEnv = {
		DB: remote.DB,
		RAW: rawBucket(remote.RAW, keys ? s3(names.raw) : null),
		MIRROR_BASE_URL: vars.MIRROR_BASE_URL,
		FIREBASE_BASE_URL: vars.FIREBASE_BASE_URL,
		RENDERS: s3(names.renders),
		SCREENSHOTS: s3(screenshotsBucket(stage)),
		RENDERS_URL: domainUrl(environ[`RENDERS_DOMAIN_${stage.toUpperCase()}`]),
		SCREENSHOTS_URL: domainUrl(environ[`SCREENSHOTS_DOMAIN_${stage.toUpperCase()}`]),
		CACHE_PURGE_TOKEN: environ.CACHE_PURGE_TOKEN?.trim() || undefined,
		CACHE_ZONE_ID: environ.CACHE_ZONE_ID?.trim() || undefined
	};
	const missing = [
		...(keys ? [] : ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']),
		...(env.CACHE_PURGE_TOKEN ? [] : ['CACHE_PURGE_TOKEN']),
		...(env.CACHE_ZONE_ID ? [] : ['CACHE_ZONE_ID'])
	];
	return { env, canPurge: missing.length === 0, missing };
}

export async function openStageGate(stage: Stage, generation?: number): Promise<StageGate> {
	if (stage === 'local') {
		const proxy = await getPlatformProxy<Env>({ persist: true, remoteBindings: false });
		return {
			env: proxy.env as unknown as GateEnv,
			label: 'local D1 and buckets (.wrangler/state)',
			canPurge: true,
			missing: [],
			dispose: () => proxy.dispose()
		};
	}
	const vars = unstable_readConfig({ config: 'wrangler.jsonc' }, { hideWarnings: true }).vars as Record<string, string>;
	const gen = generation ?? boundGeneration(stage);
	const target = await openTarget(stage, { generation: gen });
	const { env, canPurge, missing } = deployedGateEnv(stage, gen, target.env, vars, process.env, (bucket, keys) =>
		s3Store({ accountId: accountId(), bucket, ...keys })
	);
	return { env, label: `${target.database}, ${target.bucket}`, canPurge, missing, dispose: target.dispose };
}
