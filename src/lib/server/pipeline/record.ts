import { Schema } from 'effect';

/**
 * A `/blueprints/$id` node from factorioprints' Firebase database, as mirrored by
 * motlin/factorio-blueprint-firebase-cdn. Mirrors the frontend's zod schema in
 * FactorioBlueprints/factorio-prints src/schemas.ts.
 *
 * Unknown keys are dropped on decode, so the decoded record never holds `favorites` (who
 * favourited) or `image.deletehash`; the archived raw text is stripped of them by
 * `stripPrivateFields` before it is stored.
 */
const Timestamp = Schema.Union([Schema.Number, Schema.String]);

const SITE = Schema.Literals(['factorioprints', 'upload', 'factoriobin', 'codex', 'fprints']);
const NullableNumber = Schema.optional(Schema.NullOr(Schema.Number));

/**
 * Where a record from another site came from (source-record.ts `toPipelineText`); factorioprints'
 * own records never have it.
 */
const PipelineSource = Schema.Struct({
	site: SITE,
	siteId: Schema.String,
	url: Schema.String,
	author: Schema.optional(
		Schema.NullOr(Schema.Struct({ site: SITE, id: Schema.NullOr(Schema.String), name: Schema.NullOr(Schema.String) }))
	),
	image: Schema.optional(Schema.NullOr(Schema.Struct({ key: Schema.String, url: Schema.String }))),
	uploadedAt: NullableNumber,
	updatedAt: NullableNumber,
	versions: Schema.optional(Schema.Array(Schema.String)),
	sourceHints: Schema.optional(Schema.Array(Schema.String))
});

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
	),
	source: Schema.optional(PipelineSource)
});

export type FirebaseRecord = typeof FirebaseRecord.Type;

export const toEpochMs = (t: number | string | undefined): number | null => {
	if (t === undefined) return null;
	if (typeof t === 'number') return t;
	const ms = Date.parse(t);
	return Number.isNaN(ms) ? null : ms;
};

/**
 * A record's JSON text without the fields we must never store or republish: `favorites` maps the
 * user ids of everyone who favourited the print, and `image.deletehash` (an Imgur deletion secret)
 * isn't ours to keep. A top-level `source` (which site the record is from) is dropped too unless
 * `keepSource`: only `toPipelineText` (source-record.ts) writes one, and a factorioprints record that
 * carried its own must not pass for another site's. Throws when the text isn't JSON.
 */
export const stripPrivateFields = (text: string, keepSource = false): string => JSON.stringify(stripPrivate(JSON.parse(text), keepSource));

/** `stripPrivateFields` on a parsed record, in place (returned for chaining). Throws for `null`, as the text version does. */
export const stripPrivate = (value: unknown, keepSource = false): unknown => {
	const record = value as Record<string, unknown>;
	delete record.favorites;
	if (!keepSource) delete record.source;
	const image = record.image as Record<string, unknown> | undefined;
	if (image && typeof image === 'object') delete image.deletehash;
	return record;
};
