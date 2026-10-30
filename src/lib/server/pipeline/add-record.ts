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
 *   shows if it is the print's credited source. When the print has other live sources and the record's new
 *   whole-print hash isn't the print's, the print splits, by who owns its URL (the first ingestion: the
 *   source whose own id is the print's id):
 *   - the print is this record's own: it keeps the print (and shows), and every other source moves to a
 *     print of its own id with the content it has (`moved`);
 *   - else this record leaves (`detachedFrom`): marked gone, the credit handed to the next source if it was
 *     the one shown, the print's sources list put right, then added afresh ('new' under its own id, or a
 *     join of whatever it now copies).
 *   So a copy edited into something else never takes another source's print, or its identity, with it.
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
import { bumpPageVersion } from '../page-cache.js';
import { admitRecord, type Admission, type AdmitLimits, type Suggestion } from './admit.js';
import { blockedBy, liveSources, sourcesOf, type PrintSourceRow } from './identity-db.js';
import { ingestRecord, postedLater, syncSources } from './pipeline.js';
import { RawStoreR2 } from './raw-store.js';
import { PrintRepositoryD1 } from './repository.js';
import { fromFactorioprints, fromPipelineText, rawKeyFor, toPipelineText, type SourceRecord } from './source-record.js';

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

export type AddResult = AddOutcome & {
	readonly planned: boolean;
	/** With `update`: the record left this print (its new content isn't the print's, and the print isn't its own) before it was added. */
	readonly detachedFrom?: string;
	/** With `update`, on the record's own print: the other sources that moved off it (`printId` null: kept, see `reason`). */
	readonly moved?: readonly MovedSource[];
};

export interface MovedSource {
	readonly site: Site;
	readonly siteId: string;
	readonly printId: string | null;
	readonly reason?: string;
}

/** A source's record as archived in RAW (`<site>/<siteId>.json`; factorioprints' own text under its key). */
export const archivedRecord = async (raw: R2Bucket, site: Site, siteId: string): Promise<SourceRecord | null> => {
	const obj = await raw.get(rawKeyFor(site, siteId));
	if (!obj) return null;
	const text = await obj.text();
	return site === 'factorioprints' ? fromFactorioprints(siteId, text) : fromPipelineText(text);
};

/**
 * Whether an update of a known source splits its print: the print has other live sources, and the record's
 * new whole-print hash isn't the print's. `owner`: the print is this source's own (its id is the source's,
 * the first ingestion); `shown`: this source is the one the print shows; `next`: who'd be credited without it.
 */
async function planSplit(db: D1Database, record: SourceRecord, printId: string, newHash: string | null) {
	const sources = await sourcesOf(db, printId);
	const same = (s: PrintSourceRow) => s.site === record.site && s.site_id === record.siteId;
	const others = liveSources(sources).filter((s) => !same(s));
	if (!others.length) return null;
	const current = await db
		.prepare(`SELECT sha256 FROM print_fingerprints WHERE print_id = ? AND kind = 'print' AND current = 1`)
		.bind(printId)
		.first<{ sha256: string }>();
	if ((current?.sha256 ?? null) === newHash) return null;
	let own: string | null = null;
	try {
		own = printIdFor(record.site, record.siteId);
	} catch {
		// No print id of its own: never the owner.
	}
	return { owner: own === printId, shown: !postedLater(record, sources), next: others[0] ?? null, others };
}

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

	const layer = Layer.mergeAll(RawStoreR2(b.RAW), PrintRepositoryD1(b.DB));
	const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) => Effect.runPromise(Effect.provide(effect, layer));
	const moved: MovedSource[] = [];
	if (known && admission.status === 'existing') {
		// The site changed a record that is one of several sources of this print, into something else: the
		// print and its sources split (see the header). Never let the new content become another source's print.
		let split;
		try {
			split = await planSplit(b.DB, record, printId, admission.admitted.fingerprint.whole?.exact ?? null);
		} catch (e) {
			return done({ status: 'failed', reason: reasonOf(e) });
		}
		if (split?.owner === false) {
			// Not the first ingestion of this print: this source leaves it. Marked gone first and the print's
			// sources list (and credit, when it was the one shown) put right, then its row deleted and the record
			// added afresh, so a run cut short anywhere does the rest next time.
			try {
				// When it was the one shown, the next source takes the credit: its record first, or nothing moves.
				const next = split.shown && split.next ? await archivedRecord(b.RAW, split.next.site, split.next.site_id) : null;
				if (split.shown && split.next && !next)
					throw new Error(`no archived record of ${split.next.site}:${split.next.site_id} to hand ${printId} to`);
				await b.DB.batch([
					b.DB.prepare('UPDATE print_sources SET gone_at = ? WHERE site = ? AND site_id = ? AND print_id = ? AND gone_at IS NULL').bind(
						o.now ?? Date.now(),
						record.site,
						record.siteId,
						printId
					),
					bumpPageVersion(b.DB, o.now)
				]);
				if (next && split.next) {
					const r = await addRecord(b, next, { ...o, update: true });
					if (r.status === 'failed') throw new Error(`handing ${printId} to ${split.next.site}:${split.next.site_id}: ${r.reason}`);
				}
				await run(syncSources(printId, { bump: false }));
				await b.DB.prepare('DELETE FROM print_sources WHERE site = ? AND site_id = ? AND print_id = ?')
					.bind(record.site, record.siteId, printId)
					.run();
			} catch (e) {
				return done({ status: 'failed', reason: reasonOf(e) });
			}
			return { ...(await addRecord(b, record, { ...o, update: false })), detachedFrom: printId };
		}
		if (split?.owner === true) {
			// This source's own print (the URL it was first ingested under): it keeps the print and the others move
			// off, each to a print of its own (its own id) with the content it has. One at a time, each in one batch
			// (its source row moves with the new print), so a run cut short moves the rest next time.
			for (const other of split.others) {
				try {
					const rec = await archivedRecord(b.RAW, other.site, other.site_id);
					const admitted = rec ? await admitRecord(b.DB, rec, o.maxInflatedBytes ? { maxInflatedBytes: o.maxInflatedBytes } : {}) : null;
					if (!rec || !admitted || (admitted.status !== 'existing' && admitted.status !== 'new')) {
						moved.push({
							site: other.site,
							siteId: other.site_id,
							printId: null,
							reason: rec ? `came out ${admitted?.status}` : 'no archived record'
						});
						continue;
					}
					const own = printIdFor(other.site, other.site_id);
					const r = await run(
						ingestRecord(
							rec,
							{ status: 'new', copyOf: null, admitted: admitted.admitted, printId: own },
							{
								extra: () => [bumpPageVersion(b.DB, o.now)],
								...(o.maxInflatedBytes ? { maxInflatedBytes: o.maxInflatedBytes } : {})
							}
						)
					);
					moved.push({
						site: other.site,
						siteId: other.site_id,
						printId: r.status === 'analysed' ? own : null,
						reason: r.status === 'analysed' ? undefined : r.status
					});
				} catch (e) {
					return done({ status: 'failed', reason: `moving ${other.site}:${other.site_id} off ${printId}: ${reasonOf(e)}` });
				}
			}
			// A source that couldn't move and was posted first would still be the one shown: the edited content
			// must not become that print's identity. Stop; the next run tries the move again.
			try {
				const stayed = liveSources(await sourcesOf(b.DB, printId)).filter((x) => !(x.site === record.site && x.site_id === record.siteId));
				if (postedLater(record, stayed))
					return {
						...done({
							status: 'failed',
							reason: `${stayed.map((x) => `${x.site}:${x.site_id}`).join(', ')} couldn't move off ${printId} and was posted before it`
						}),
						moved
					};
			} catch (e) {
				return done({ status: 'failed', reason: reasonOf(e) });
			}
		}
	}

	const full: Admission = admission.status === 'existing' ? admission : { ...admission, printId };
	let outcome;
	try {
		outcome = await Effect.runPromise(
			Effect.provide(
				ingestRecord(record, full, {
					extra: () => [bumpPageVersion(b.DB, o.now)],
					...(o.maxInflatedBytes ? { maxInflatedBytes: o.maxInflatedBytes } : {})
				}),
				layer
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
		return { ...done({ status: 'already', printId, updated: true }), ...(moved.length ? { moved } : {}) };
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
