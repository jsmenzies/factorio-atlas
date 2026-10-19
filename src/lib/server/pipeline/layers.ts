import { Layer } from 'effect';
import { RawStoreR2 } from './raw-store';
import { PrintRepositoryD1 } from './repository';
import { PrintSourceLive } from './source';

/** Everything the pipeline needs, built from Worker bindings (or a local platform proxy). */
export const pipelineLayer = (env: Env) =>
	Layer.mergeAll(
		PrintSourceLive({ mirrorBaseUrl: env.MIRROR_BASE_URL, firebaseBaseUrl: env.FIREBASE_BASE_URL }),
		RawStoreR2(env.RAW),
		PrintRepositoryD1(env.DB)
	);
