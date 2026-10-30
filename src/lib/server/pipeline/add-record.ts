/**
 * Adding one record from another site by hand (an admin's "add by URL"), through the one gate: removal
 * blocks, exact-duplicate joins and known sources all come from `admitRecord`, the writes from
 * `ingestRecord`. Nothing here fingerprints or compares prints itself.
 *
 * Contract, for any site whose records arrive one at a time (factoriobin today):
 * - `planned: true` reads D1 only and answers what adding would do; nothing is written.
 * - 'new': the record becomes print `printIdFor(site, siteId)` (`fbin-…`), analysed, in search at once.
 * - 'joins': the same blueprint (whole-print exact hash, from JOIN_MIN_SIZE up) is already print
 *   `printId`; the record becomes another of its sources. `shown` when it was posted before every other
 *   live source (first upload wins: the print now shows this record), else only its source row and hashes
 *   are written.
 * - 'already': this site's record is already a source of `printId`; nothing is written, unless `update`
 *   (a polled site's changed record, scripts/polled.ts): then it is ingested again (`updated: true`), and
 *   shows if it is the print's credited source.
 * - 'blocked' (an approved removal), 'unreadable', 'too-big' (over `limits`: the Worker's caps; add it from
 *   a Bun run instead), 'failed' (storage: nothing or part written, safe to try again).
 * - Once written, the record's text is archived in RAW at `<site>/<siteId>.json` (source-record.ts
 *   `rawKeyFor`) whether it shows or not, so a later hand-over (source-gone.ts) can ingest it again.
 * - Every write bumps the page cache in the print's own D1 batch, so search and the print page show it.
 *
 * Runs in the Worker and in Bun alike (D1 and R2 bindings, or a Bun script's stage bindings).
 */
import { Effect, Layer } from 'effect';
import { printIdFor, type Site } from '#lib/print-id.js';
import { bumpPageVersion } from '../page-cache';
import { admitRecord, type Admission, type AdmitLimits, type Suggestion } from './admit';
import { blockedBy } from './identity-db';
import { ingestRecord } from './pipeline';
import { RawStoreR2 } from './raw-store';
import { PrintRepositoryD1 } from './repository';
import { rawKeyFor, toPipelineText, type SourceRecord } from './source-record';

export interface AddBindings {
	readonly DB: D1Database;
	readonly RAW: R2Bucket;
}

export interface AddOptions {
	/** Caps (the Worker's WORKER_LIMITS); none in Bun. */
	readonly limits?: AdmitLimits;
	/** Say what adding would do, write nothing. */
	readonly plan?: boolean;
	/** decode's zip-bomb cap: Bun runs pass OFFLINE_MAX_INFLATED_BYTES (decode.ts's default when omitted). */
	readonly maxInflatedBytes?: number;
	/** A source already known is ingested again (its site changed the record): 'already' with `updated`. */
	readonly update?: boolean;
	readonly now?: number;
}

export type AddOutcome =
	| { readonly status: 'new'; readonly printId: string; readonly suggestions: readonly Suggestion[] }
	| { readonly status: 'joins'; readonly printId: string; readonly shown: boolean | null; readonly suggestions: readonly Suggestion[] }
	| { readonly status: 'already'; readonly printId: string; readonly updated?: boolean }
	| { readonly status: 'blocked'; readonly by: string }
	| { readonly status: 'unreadable'; readonly reason: string }
	| { readonly status: 'too-big'; readonly by: 'string' | 'entities'; readonly size: number; readonly limit: number }
	| { readonly status: 'failed'; readonly reason: string };

export type AddResult = AddOutcome & { readonly planned: boolean };

/**
 * What a source is before its record is read: blocked by an approved removal, already a source of a live
 * print, or null (not known). For a record too big to fetch where the caller runs.
 */
export async function knownSource(
	db: D1Database,
	site: Site,
	siteId: string
): Promise<Extract<AddOutcome, { status: 'blocked' | 'already' }> | null> {
	if ((await blockedBy(db, { site, siteId }, []))?.by === 'source') return { status: 'blocked', by: 'source' };
	const row = await db
		.prepare(`SELECT s.print_id AS print_id FROM print_sources s JOIN prints p ON p.id = s.print_id WHERE s.site = ? AND s.site_id = ?`)
		.bind(site, siteId)
		.first<{ print_id: string }>();
	return row ? { status: 'already', printId: row.print_id } : null;
}

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Admit `record` and, unless planning, ingest it: see the header. */
export async function addRecord(b: AddBindings, record: SourceRecord, o: AddOptions = {}): Promise<AddResult> {
	const planned = Boolean(o.plan);
	const done = (r: AddOutcome): AddResult => ({ ...r, planned });
	let admission;
	try {
		admission = await admitRecord(b.DB, record, {
			...(o.limits ? { limits: o.limits } : {}),
			...(o.maxInflatedBytes ? { maxInflatedBytes: o.maxInflatedBytes } : {})
		});
	} catch (e) {
		return done({ status: 'failed', reason: reasonOf(e) });
	}
	switch (admission.status) {
		case 'blocked':
			return done({ status: 'blocked', by: admission.by });
		case 'undecodable':
			return done({ status: 'unreadable', reason: admission.reason });
		case 'too-big': {
			// The gate stops at the cap before it looks the source up: a post added already says so.
			const known = await knownSource(b.DB, record.site, record.siteId).catch(() => null);
			return done(known ?? { status: 'too-big', by: admission.by, size: admission.size, limit: admission.limit });
		}
		case 'existing':
			if (admission.via === 'source' && (!o.update || planned)) return done({ status: 'already', printId: admission.printId });
			break;
		case 'new':
			break;
	}
	const printId = admission.status === 'existing' ? admission.printId : printIdFor(record.site, record.siteId);
	const join = admission.status === 'existing' && admission.via === 'exact';
	const known = admission.status === 'existing' && admission.via === 'source';
	const suggestions = admission.admitted.suggestions;
	if (planned) return done(join ? { status: 'joins', printId, shown: null, suggestions } : { status: 'new', printId, suggestions });

	const full: Admission = admission.status === 'existing' ? admission : { ...admission, printId };
	let outcome;
	try {
		outcome = await Effect.runPromise(
			Effect.provide(
				ingestRecord(record, full, {
					extra: () => [bumpPageVersion(b.DB, o.now)],
					...(o.maxInflatedBytes ? { maxInflatedBytes: o.maxInflatedBytes } : {})
				}),
				Layer.mergeAll(RawStoreR2(b.RAW), PrintRepositoryD1(b.DB))
			)
		);
	} catch (e) {
		return done({ status: 'failed', reason: reasonOf(e) });
	}
	switch (outcome.status) {
		case 'analysed':
		case 'identified':
			break;
		case 'removed':
			return done({ status: 'blocked', by: 'print' });
		case 'blocked':
			return done({ status: 'blocked', by: 'sha256' });
		case 'failed':
		case 'skipped-failed':
			return done({ status: 'unreadable', reason: outcome.reason });
		default:
			return done({ status: 'failed', reason: `ingest answered ${outcome.status}` });
	}
	if (known) {
		if (outcome.status === 'identified') {
			try {
				await b.RAW.put(rawKeyFor(record.site, record.siteId), toPipelineText(record), {
					httpMetadata: { contentType: 'application/json' }
				});
			} catch (e) {
				return done({ status: 'failed', reason: `archiving the record: ${reasonOf(e)}` });
			}
		}
		return done({ status: 'already', printId, updated: true });
	}
	// 'analysed' archived the text already (applyPlan); a source that doesn't show is archived here.
	if (outcome.status === 'identified') {
		try {
			await b.RAW.put(rawKeyFor(record.site, record.siteId), toPipelineText(record), { httpMetadata: { contentType: 'application/json' } });
		} catch (e) {
			return done({ status: 'failed', reason: `archiving the record: ${reasonOf(e)}` });
		}
	}
	return done(
		join ? { status: 'joins', printId, shown: outcome.status === 'analysed', suggestions } : { status: 'new', printId, suggestions }
	);
}
