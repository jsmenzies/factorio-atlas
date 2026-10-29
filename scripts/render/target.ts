/**
 * The bucket `bun run render --upload local|prod` writes to, opened and checked before the run
 * starts, and RENDER_DELETE_GRACE_S. Errors are thrown with the message the runner prints.
 */
import { accountId, boundGeneration, resourceNames } from '../backfill/stage.js';
import { bindingStore, s3Store, withRetries, type RenderStore } from './store.js';
import { DELETE_GRACE_MS, MIN_DELETE_GRACE_MS, type UploadTarget } from './upload.js';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The store for `target`, or null without one. `local` is the miniflare RENDERS binding; `prod` is
 * the deployed bucket through R2's S3 API with R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, checked
 * with one cheap request, so wrong credentials or a missing bucket show now rather than after the
 * first render.
 */
export async function openStore(
	target: UploadTarget | null,
	/** The miniflare RENDERS binding; only `local` needs it. */
	local: R2Bucket | null,
	env: Record<string, string | undefined> = process.env
): Promise<RenderStore | null> {
	if (target === 'local') {
		if (!local) throw new Error('the local RENDERS binding is needed for --upload local');
		return bindingStore(local, 'local RENDERS bucket (.wrangler/state)');
	}
	if (target !== 'prod') return null;
	const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
	const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
	if (!accessKeyId || !secretAccessKey) {
		throw new Error(
			'--upload prod needs an R2 API token: set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (in .env or the environment). ' +
				'Create one in the Cloudflare dashboard under R2 → Manage API tokens, with Object Read & Write on the renders bucket (docs/deploy.md, "Uploading renders").'
		);
	}
	try {
		const bucket = resourceNames('prod', boundGeneration('prod')).renders;
		const store = s3Store({ accountId: accountId(), bucket, accessKeyId, secretAccessKey });
		await withRetries(() => store.list('index.json'), { attempts: 3 });
		return store;
	} catch (e) {
		throw new Error(`--upload prod: ${message(e)}`);
	}
}

/**
 * How long replaced files wait before they are deleted: DELETE_GRACE_MS, or RENDER_DELETE_GRACE_S
 * (seconds) when set, which may go below the edge and browser caches' MIN_DELETE_GRACE_MS only
 * with the local bucket (for tests).
 */
export function deleteGraceMs(value: string | undefined, target: UploadTarget): number {
	const set = value?.trim();
	if (!set) return DELETE_GRACE_MS;
	const s = Number(set);
	if (!Number.isFinite(s) || s < 0) throw new Error(`RENDER_DELETE_GRACE_S must be a number of seconds, not ${set}`);
	if (target !== 'local' && s * 1000 < MIN_DELETE_GRACE_MS) {
		throw new Error(
			`RENDER_DELETE_GRACE_S=${set} is shorter than the edge and browser caches allow (${MIN_DELETE_GRACE_MS / 1000} s); only --upload local takes less`
		);
	}
	return s * 1000;
}
