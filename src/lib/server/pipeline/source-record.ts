/**
 * A print's record from any site, in one shape (`SourceRecord`), and how the pipeline ingests it.
 *
 * The pipeline builds every analysis document, D1 row and search token from factorioprints' record
 * shape (`FirebaseRecord`), keyed by its archived JSON text: that text is the change key
 * (`fingerprint` in pipeline.ts) and goes to RAW as is. So:
 * - a factorioprints record is ingested from its own text (`native`), exactly as before;
 * - any other site's record becomes that shape plus a `source` object (`toPipelineText`), archived
 *   at `<site>/<siteId>.json`. Its author is credited by name only (no `by_` token or `authors` row,
 *   which are factorioprints user ids).
 */
import type { Site } from '#lib/print-id.js';
import { sourceUrl } from '#lib/format.js';
import { stripPrivateFields, toEpochMs, type FirebaseRecord } from './record';

export interface SourceAuthor {
	readonly site: Site;
	readonly id: string | null;
	readonly name: string | null;
}

export interface SourceRecord {
	readonly site: Site;
	/** The site's own id; an upload's 10 base62 characters (print id `up-<siteId>`). */
	readonly siteId: string;
	/** The print's page on that site (an upload: our own print page). */
	readonly url: string;
	readonly title: string | null;
	/** Markdown or plain text. */
	readonly description: string | null;
	readonly author: SourceAuthor | null;
	readonly blueprintString: string;
	/** Older strings of the same print (codex keeps them). */
	readonly versions?: readonly string[];
	/** The screenshot: an Imgur id for factorioprints, `upload.<16 hex>` once an upload's is approved, else null. */
	readonly image: { readonly key: string; readonly url: string } | null;
	/** Unix ms: when the site says it was posted. Decides who is credited (first upload wins). */
	readonly uploadedAt: number | null;
	readonly updatedAt: number | null;
	readonly favorites: number | null;
	/** The site's own tags (factorioprints' "/version/2,0/" and the like), as search tags. */
	readonly tags?: readonly string[];
	/** URLs in the record that may name the same print elsewhere (remixed_from_url, links in the description). */
	readonly sourceHints: readonly string[];
	/** The site's own record text as archived; required for factorioprints (its text is the change key). */
	readonly native?: string;
}

/** What `print_sources` keeps of a record (identity-db.ts). */
export interface SourceMeta {
	readonly site: Site;
	readonly siteId: string;
	readonly url: string;
	readonly uploadedAt: number | null;
	readonly updatedAt: number | null;
}

/** The `source` object of a pipeline record from another site (record.ts `FirebaseRecord.source`). */
export interface PipelineSource {
	readonly site: Site;
	readonly siteId: string;
	readonly url: string;
	readonly author?: SourceAuthor | null;
	readonly image?: { readonly key: string; readonly url: string } | null;
	readonly uploadedAt?: number | null;
	readonly updatedAt?: number | null;
	readonly versions?: readonly string[];
	readonly sourceHints?: readonly string[];
}

/** A title for records that have none (factoriobin strings without a label). */
export const UNTITLED = 'Untitled blueprint';

/** The RAW key of a record's archived text. factorioprints' stays `factorioprints/<id>.json`. */
export const rawKeyFor = (site: Site, siteId: string) => `${site}/${siteId}.json`;

/** A record from another site as the text the pipeline ingests and archives. Throws for factorioprints. */
export const toPipelineText = (r: SourceRecord): string => {
	if (r.site === 'factorioprints') throw new Error('factorioprints records are ingested from their own text');
	const source: PipelineSource = {
		site: r.site,
		siteId: r.siteId,
		url: r.url,
		author: r.author,
		image: r.image,
		uploadedAt: r.uploadedAt,
		updatedAt: r.updatedAt,
		...(r.versions?.length ? { versions: r.versions } : {}),
		sourceHints: r.sourceHints
	};
	return JSON.stringify({
		title: r.title?.trim() || UNTITLED,
		blueprintString: r.blueprintString,
		...(r.description ? { descriptionMarkdown: r.description } : {}),
		...(r.uploadedAt !== null ? { createdDate: r.uploadedAt } : {}),
		...(r.updatedAt !== null ? { lastUpdatedDate: r.updatedAt } : {}),
		...(r.tags?.length ? { tags: r.tags } : {}),
		numberOfFavorites: r.favorites ?? 0,
		...(r.image ? { image: { id: r.image.key } } : {}),
		source
	});
};

/**
 * The SourceRecord a pipeline text from another site was made from: `toPipelineText` turned back, for
 * records whose only copy is that text in RAW (uploads; a hand-over to another site's source). Null when
 * the text isn't one (not JSON, no `source`, no string).
 */
export const fromPipelineText = (text: string): SourceRecord | null => {
	let r: Partial<FirebaseRecord>;
	try {
		r = JSON.parse(text) as Partial<FirebaseRecord>;
	} catch {
		return null;
	}
	const s = r.source;
	if (!s || s.site === 'factorioprints' || typeof r.blueprintString !== 'string') return null;
	return {
		site: s.site,
		siteId: s.siteId,
		url: s.url,
		title: r.title ?? null,
		description: r.descriptionMarkdown ?? null,
		author: s.author ?? null,
		blueprintString: r.blueprintString,
		...(s.versions?.length ? { versions: s.versions } : {}),
		image: s.image ?? null,
		uploadedAt: s.uploadedAt ?? null,
		updatedAt: s.updatedAt ?? null,
		favorites: r.numberOfFavorites ?? null,
		tags: r.tags ?? [],
		sourceHints: s.sourceHints ?? []
	};
};

/** The text to ingest a record from: factorioprints' own (sanitised), anything else's `toPipelineText`. */
export const pipelineText = (r: SourceRecord): string => {
	if (r.site !== 'factorioprints') return toPipelineText(r);
	if (r.native === undefined) throw new Error(`factorioprints ${r.siteId}: no record text`);
	return stripPrivateFields(r.native);
};

/** A factorioprints record (the mirror's or Firebase's JSON text) as a SourceRecord. Throws when it isn't JSON. */
export const fromFactorioprints = (id: string, text: string): SourceRecord => {
	const native = stripPrivateFields(text);
	const r = JSON.parse(native) as Partial<FirebaseRecord>;
	const userId = r.author?.userId ?? r.authorId ?? null;
	return {
		site: 'factorioprints',
		siteId: id,
		url: sourceUrl(id) ?? '',
		title: r.title ?? null,
		description: r.descriptionMarkdown ?? null,
		author: userId || r.author?.displayName ? { site: 'factorioprints', id: userId, name: r.author?.displayName ?? null } : null,
		blueprintString: r.blueprintString ?? '',
		image: r.image?.id ? { key: r.image.id, url: `https://i.imgur.com/${r.image.id}.png` } : null,
		uploadedAt: toEpochMs(r.createdDate),
		updatedAt: toEpochMs(r.lastUpdatedDate),
		favorites: r.numberOfFavorites ?? null,
		tags: r.tags ?? [],
		sourceHints: [],
		native
	};
};

/** The source a pipeline record came from: its `source` object, else factorioprints under the print's own id. */
export const sourceMetaOf = (printId: string, r: Pick<FirebaseRecord, 'createdDate' | 'lastUpdatedDate' | 'source'>): SourceMeta =>
	r.source
		? {
				site: r.source.site,
				siteId: r.source.siteId,
				url: r.source.url,
				uploadedAt: r.source.uploadedAt ?? null,
				updatedAt: r.source.updatedAt ?? null
			}
		: {
				site: 'factorioprints',
				siteId: printId,
				url: sourceUrl(printId) ?? `https://factorioprints.com/view/${printId}`,
				uploadedAt: toEpochMs(r.createdDate),
				updatedAt: toEpochMs(r.lastUpdatedDate)
			};

/** What `print_sources` keeps of a SourceRecord. */
export const sourceMetaOfRecord = (r: SourceRecord): SourceMeta => ({
	site: r.site,
	siteId: r.siteId,
	url: r.url,
	uploadedAt: r.uploadedAt,
	updatedAt: r.updatedAt
});

/** The archive key for a pipeline record's text, read without the schema (so failed records land in the right place). */
export const rawKeyOfText = (printId: string, text: string): string => {
	try {
		const s = (JSON.parse(text) as { source?: { site?: unknown; siteId?: unknown } }).source;
		if (s && typeof s.site === 'string' && typeof s.siteId === 'string' && s.site !== 'factorioprints') {
			return rawKeyFor(s.site as Site, s.siteId);
		}
	} catch {
		// Not JSON: archived under the print's own key, as before.
	}
	return rawKeyFor('factorioprints', printId);
};
