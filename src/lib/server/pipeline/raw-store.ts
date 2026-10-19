import { Context, Effect, Layer } from 'effect';
import { StorageError } from './errors';

/** Content-addressed-ish archive of source records, so analysis can be re-run offline. */
export class RawStore extends Context.Service<
	RawStore,
	{
		/** `contentType` defaults to JSON; viewer page strings are plain text. */
		readonly put: (key: string, body: string, contentType?: string) => Effect.Effect<void, StorageError>;
		readonly get: (key: string) => Effect.Effect<string | null, StorageError>;
		readonly delete: (key: string) => Effect.Effect<void, StorageError>;
	}
>()('RawStore') {}

export const RawStoreR2 = (bucket: R2Bucket) =>
	Layer.succeed(RawStore, {
		put: (key, body, contentType = 'application/json') =>
			Effect.tryPromise({
				try: () => bucket.put(key, body, { httpMetadata: { contentType } }),
				catch: (cause) => new StorageError({ op: `r2.put ${key}`, cause })
			}).pipe(Effect.asVoid),
		get: (key) =>
			Effect.tryPromise({
				try: async () => (await bucket.get(key))?.text() ?? null,
				catch: (cause) => new StorageError({ op: `r2.get ${key}`, cause })
			}),
		delete: (key) =>
			Effect.tryPromise({
				try: () => bucket.delete(key),
				catch: (cause) => new StorageError({ op: `r2.delete ${key}`, cause })
			})
	});
