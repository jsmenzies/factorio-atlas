import { Context, Effect, Layer, Schema } from 'effect';
import { isFactorioprintsId } from '#lib/print-id.js';
import { FetchError, NotFoundError } from './errors.js';

export interface SourceConfig {
	/** GitHub mirror of `/blueprints`, one JSON file per print. Bulk reads go here. */
	readonly mirrorBaseUrl: string;
	/** Live Firebase. Only small queries; its bandwidth is billed to the site's maintainer. */
	readonly firebaseBaseUrl: string;
}

export interface Summary {
	readonly id: string;
	readonly title: string;
	readonly numberOfFavorites: number;
}

/** Where raw factorioprints records come from. */
export class PrintSource extends Context.Service<
	PrintSource,
	{
		/** Raw `/blueprints/$id` JSON text, mirror first, Firebase as fallback for prints newer than the mirror. */
		readonly fetchRecord: (id: string) => Effect.Effect<{ text: string; url: string }, FetchError | NotFoundError>;
		readonly topByFavorites: (n: number) => Effect.Effect<Summary[], FetchError>;
	}
>()('PrintSource') {}

/** The mirror shards by the lowercased first three characters of the key. */
export const mirrorPath = (id: string) => `${id.slice(0, 3).toLowerCase()}/${id}.json`;

const getText = (url: string) =>
	Effect.tryPromise({
		try: () => fetch(url, { headers: { 'user-agent': 'factorio-atlas (local dev ingest)' } }),
		catch: (cause) => new FetchError({ url, cause })
	}).pipe(
		Effect.flatMap((res) =>
			res.ok
				? Effect.tryPromise({ try: () => res.text(), catch: (cause) => new FetchError({ url, cause }) })
				: Effect.fail(new FetchError({ url, status: res.status }))
		)
	);

const SummaryMap = Schema.Record(Schema.String, Schema.Struct({ title: Schema.String, numberOfFavorites: Schema.Number }));

export const PrintSourceLive = (config: SourceConfig) =>
	Layer.succeed(PrintSource, {
		fetchRecord: (id) =>
			Effect.gen(function* () {
				if (!isFactorioprintsId(id)) return yield* new NotFoundError({ id });
				const mirrorUrl = `${config.mirrorBaseUrl}/${mirrorPath(id)}`;
				const fromMirror = yield* getText(mirrorUrl).pipe(
					Effect.map((text) => ({ text, url: mirrorUrl })),
					Effect.catchTag('FetchError', (e) => (e.status === 404 ? Effect.succeed(null) : Effect.fail(e)))
				);
				if (fromMirror) return fromMirror;
				const fbUrl = `${config.firebaseBaseUrl}/blueprints/${id}.json`;
				const text = yield* getText(fbUrl);
				// Firebase answers a missing key with 200 and `null`.
				if (text.trim() === 'null') return yield* new NotFoundError({ id });
				return { text, url: fbUrl };
			}),
		topByFavorites: (n) =>
			Effect.gen(function* () {
				const url = `${config.firebaseBaseUrl}/blueprintSummaries.json?orderBy=%22numberOfFavorites%22&limitToLast=${n}`;
				const text = yield* getText(url);
				const map = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SummaryMap))(text).pipe(
					Effect.mapError((cause) => new FetchError({ url, cause }))
				);
				return Object.entries(map)
					.map(([id, s]) => ({ id, title: s.title, numberOfFavorites: s.numberOfFavorites }))
					.sort((a, b) => b.numberOfFavorites - a.numberOfFavorites);
			})
	});
