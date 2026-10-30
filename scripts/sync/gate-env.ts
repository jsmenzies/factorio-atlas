/**
 * The site's gate (src/lib/server/uploads/gate.ts `workerGate`: admit, ingest, hand-over and purge) on a
 * stage, for a Bun script that polls another site (scripts/fprints.ts): the same bindings the site Worker
 * has. `local` is the miniflare state `bun run dev` serves, every binding included. A deployed stage's D1
 * and RAW come through the backfill's remote bindings; its RENDERS and SCREENSHOTS buckets, which a purge
 * lists and deletes from, through R2's S3 API (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY, as render and
 * screenshot uploads use), and the edge purge from CACHE_PURGE_TOKEN / CACHE_ZONE_ID when set.
 */
import { getPlatformProxy, unstable_readConfig } from 'wrangler';
import type { GateEnv } from '#lib/server/uploads/gate.js';
import { screenshotsBucket } from '../../infra/databases';
import { accountId, boundGeneration, openTarget, resourceNames, TargetError, type Stage } from '../backfill/stage';
import { s3Store, type RenderStore } from '../render/store';

export interface StageGate {
	env: GateEnv;
	/** What it reads and writes, for the status line. */
	label: string;
	/** Whether a purge can reach the buckets (a deployed stage needs the R2 keys). */
	canPurge: boolean;
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

const domainUrl = (v: string | undefined) => (v?.trim() ? `https://${v.trim()}` : '');

export async function openStageGate(stage: Stage, generation?: number): Promise<StageGate> {
	if (stage === 'local') {
		const proxy = await getPlatformProxy<Env>({ persist: true, remoteBindings: false });
		return {
			env: proxy.env as unknown as GateEnv,
			label: 'local D1 and buckets (.wrangler/state)',
			canPurge: true,
			dispose: () => proxy.dispose()
		};
	}
	const vars = unstable_readConfig({ config: 'wrangler.jsonc' }, { hideWarnings: true }).vars as Record<string, string>;
	const target = await openTarget(stage, { generation: generation ?? boundGeneration(stage) });
	const keyId = process.env.R2_ACCESS_KEY_ID?.trim();
	const secret = process.env.R2_SECRET_ACCESS_KEY?.trim();
	const s3 = (bucket: string) =>
		keyId && secret
			? storeBucket(s3Store({ accountId: accountId(), bucket, accessKeyId: keyId, secretAccessKey: secret }))
			: noBucket(bucket);
	const env: GateEnv = {
		DB: target.env.DB,
		RAW: target.env.RAW,
		MIRROR_BASE_URL: vars.MIRROR_BASE_URL,
		FIREBASE_BASE_URL: vars.FIREBASE_BASE_URL,
		RENDERS: s3(resourceNames(stage, generation ?? boundGeneration(stage)).renders),
		SCREENSHOTS: s3(screenshotsBucket(stage)),
		RENDERS_URL: domainUrl(process.env[`RENDERS_DOMAIN_${stage.toUpperCase()}`]),
		SCREENSHOTS_URL: domainUrl(process.env[`SCREENSHOTS_DOMAIN_${stage.toUpperCase()}`]),
		CACHE_PURGE_TOKEN: process.env.CACHE_PURGE_TOKEN,
		CACHE_ZONE_ID: process.env.CACHE_ZONE_ID
	};
	return { env, label: `${target.database}, ${target.bucket}`, canPurge: Boolean(keyId && secret), dispose: target.dispose };
}
