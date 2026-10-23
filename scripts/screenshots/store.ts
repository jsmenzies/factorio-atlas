/**
 * The SCREENSHOTS bucket a run writes to, through the render uploader's store (scripts/render/store.ts):
 * `local` is the miniflare binding `bun run dev` serves; `prod` the deployed bucket through R2's S3
 * API with R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, checked with one cheap request first.
 */
import { getPlatformProxy } from 'wrangler';
import { screenshotsBucket } from '../../infra/databases';
import { accountId } from '../backfill/stage.js';
import { bindingStore, s3Store, withRetries, type RenderStore } from '../render/store.js';
import type { UploadTarget } from './ledger.js';

export interface OpenStore {
	store: RenderStore;
	/** The local proxy's D1, for `local` (the removal script writes it in the same process). */
	db: D1Database | null;
	dispose: () => Promise<void>;
}

export async function openShotStore(target: UploadTarget, env: Record<string, string | undefined> = process.env): Promise<OpenStore> {
	if (target === 'local') {
		const proxy = await getPlatformProxy<Env>({ persist: true, remoteBindings: false });
		return {
			store: bindingStore(proxy.env.SCREENSHOTS, 'local SCREENSHOTS bucket (.wrangler/state)'),
			db: proxy.env.DB,
			dispose: () => proxy.dispose()
		};
	}
	const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
	const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
	const bucket = screenshotsBucket('prod');
	if (!accessKeyId || !secretAccessKey) {
		throw new Error(
			`--upload prod needs an R2 API token with Object Read & Write on ${bucket}: set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (docs/deploy.md, "Screenshots").`
		);
	}
	const store = s3Store({ accountId: accountId(), bucket, accessKeyId, secretAccessKey });
	try {
		await withRetries(() => store.list('x.json'), { attempts: 3 });
	} catch (e) {
		throw new Error(`${bucket}: ${e instanceof Error ? e.message : String(e)} (is it deployed, and does the token cover it?)`);
	}
	return { store, db: null, dispose: async () => {} };
}
