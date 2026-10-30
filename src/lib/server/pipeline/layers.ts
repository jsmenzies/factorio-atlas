import { Layer } from 'effect';
import { RawStoreR2 } from './raw-store.js';
import { PrintRepositoryD1 } from './repository.js';
import { PrintSourceLive } from './source.js';

/** The bindings the pipeline reads: the site Worker's env, the cron Worker's, or a local platform proxy's. */
export interface PipelineEnv {
	readonly DB: D1Database;
	readonly RAW: R2Bucket;
	readonly MIRROR_BASE_URL: string;
	readonly FIREBASE_BASE_URL: string;
}

/** Everything the pipeline needs, built from Worker bindings (or a local platform proxy). */
export const pipelineLayer = (env: PipelineEnv) =>
	Layer.mergeAll(
		PrintSourceLive({ mirrorBaseUrl: env.MIRROR_BASE_URL, firebaseBaseUrl: env.FIREBASE_BASE_URL }),
		RawStoreR2(env.RAW),
		PrintRepositoryD1(env.DB)
	);
