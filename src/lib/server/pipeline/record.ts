import { Schema } from 'effect';

/**
 * A `/blueprints/$id` node from factorioprints' Firebase database, as mirrored by
 * motlin/factorio-blueprint-firebase-cdn. Mirrors the frontend's zod schema in
 * FactorioBlueprints/factorio-prints src/schemas.ts.
 *
 * Unknown keys are dropped on decode, which is how `favorites` (who favourited)
 * and `image.deletehash` (an Imgur deletion secret) are kept out of our store.
 */
const Timestamp = Schema.Union([Schema.Number, Schema.String]);

export const FirebaseRecord = Schema.Struct({
	title: Schema.String,
	blueprintString: Schema.String,
	descriptionMarkdown: Schema.optional(Schema.String),
	createdDate: Schema.optional(Timestamp),
	lastUpdatedDate: Schema.optional(Timestamp),
	author: Schema.optional(
		Schema.Struct({
			userId: Schema.String,
			displayName: Schema.optional(Schema.String)
		})
	),
	authorId: Schema.optional(Schema.String),
	tags: Schema.optional(Schema.Array(Schema.String)),
	numberOfFavorites: Schema.optional(Schema.Number),
	image: Schema.optional(
		Schema.Struct({
			id: Schema.String,
			type: Schema.optional(Schema.String)
		})
	)
});

export type FirebaseRecord = typeof FirebaseRecord.Type;

export const toEpochMs = (t: number | string | undefined): number | null => {
	if (t === undefined) return null;
	if (typeof t === 'number') return t;
	const ms = Date.parse(t);
	return Number.isNaN(ms) ? null : ms;
};
