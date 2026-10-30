/**
 * Where uploads meet the shared ingest (plans: ingest and delete): dedup's gate and pipeline, and
 * removals' purge. There is no second ingest path: an upload is a SourceRecord of the site `upload`,
 * admitted by `admitRecord` with the Worker's caps and written by `ingestRecord`, with uploads' own rows
 * in the same D1 batch as the print's.
 *
 * uploads.ts talks to this module through `UploadGate`, so its tests run without the pipeline.
 */
import { Effect, Layer } from 'effect';
import type { Site } from '#lib/print-id.js';
import { admitRecord, WORKER_LIMITS, type Admission, type AdmitLimits, type Suggestion } from '../pipeline/admit';
import { sourcesOf, type PrintSourceRow } from '../pipeline/identity-db';
import { pipelineLayer, type PipelineEnv } from '../pipeline/layers';
import { ingestRecord, syncFold } from '../pipeline/pipeline';
import { RawStoreR2 } from '../pipeline/raw-store';
import { PrintRepositoryD1 } from '../pipeline/repository';
import { sourceGone } from '../pipeline/source-gone';
import { PrintSource } from '../pipeline/source';
import { fromFactorioprints, fromPipelineText, rawKeyFor, type SourceRecord } from '../pipeline/source-record';
import { purgePrintData, type TakedownEnv } from '../takedown';

export type { SourceRecord, Suggestion };

/** One source of a live print, the fields uploads read. */
export interface SourceOfPrint {
	site: Site;
	siteId: string;
	goneAt: number | null;
}

/**
 * The gate's answer, in uploads' terms:
 * - admitted: on the site at `printId` (new, or this upload's own print after an edit);
 * - too-big: over the Worker's cap; stored as 'processing' for the sync's Bun ingest;
 * - deferred: the Worker couldn't finish (storage failed part-way); stored as 'processing' too, and
 *   the sync admits it again from the record in RAW;
 * - blocked / undecodable: refused;
 * - exists: the same blueprint is already live (`sources` tell whose).
 */
export type GateOutcome =
	| { status: 'admitted'; printId: string; suggestions: readonly Suggestion[] }
	| { status: 'too-big'; by: 'string' | 'entities'; size: number; limit: number }
	| { status: 'deferred'; reason: string }
	| { status: 'blocked' }
	| { status: 'undecodable'; reason: string }
	| { status: 'exists'; printId: string; sources: SourceOfPrint[] };

/** Statements and RAW keys to delete along with a print, in purgePrintData's batch (`extra`, `extraKeys`). */
export interface PurgeExtras {
	extra: (db: D1Database) => D1PreparedStatement[];
	extraKeys: string[];
}

export interface UploadGate {
	/**
	 * Admit `record` as print `printId` and, when admitted, ingest it with `extra` statements in the same
	 * D1 batch as the print (uploads' row turning 'live').
	 */
	admit(record: SourceRecord, printId: string, extra: D1PreparedStatement[]): Promise<GateOutcome>;
	/**
	 * The upload's source is gone (its owner deleted it, or the account): if another source keeps the
	 * print it stays (hand-over), else the print is purged with `extras`.
	 */
	sourceGone(siteId: string, extras: PurgeExtras): Promise<'purged' | 'kept' | 'none'>;
	/** Whether an upload image is blocked: removal_blocks kind 'image', value `upload.<16 hex>` (`imageId` is the 16 hex). */
	imageBlocked(imageId: string): Promise<boolean>;
}

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What admitting an upload needs: the stage's D1 and RAW (the Worker's env, or a Bun script's stage bindings). */
export interface AdmitBindings {
	readonly DB: D1Database;
	readonly RAW: R2Bucket;
}

/**
 * Admit `record` as print `printId` and, when admitted, ingest it with `extra` in the print's D1 batch.
 * The Worker passes WORKER_LIMITS; the sync's Bun run (scripts/uploads.ts) none, so a 'processing'
 * upload comes out exactly as it would have in the Worker, only without the caps.
 */
export const admitUpload = async (
	b: AdmitBindings,
	record: SourceRecord,
	printId: string,
	extra: D1PreparedStatement[],
	limits?: AdmitLimits
): Promise<GateOutcome> => {
	let r;
	try {
		r = await admitRecord(b.DB, record, limits ? { limits } : {});
	} catch (e) {
		// Storage, not the record: the caller keeps it 'processing' for the sync, as a failed ingest.
		console.warn(`uploads: ${printId} deferred to the sync, admitting failed: ${reasonOf(e)}`);
		return { status: 'deferred', reason: reasonOf(e) };
	}
	switch (r.status) {
		case 'too-big':
			return { status: 'too-big', by: r.by, size: r.size, limit: r.limit };
		case 'blocked':
			return { status: 'blocked' };
		case 'undecodable':
			return { status: 'undecodable', reason: r.reason };
		case 'existing':
			if (r.via === 'exact') {
				const rows = await sourcesOf(b.DB, r.printId);
				return { status: 'exists', printId: r.printId, sources: rows.map((s) => ({ site: s.site, siteId: s.site_id, goneAt: s.gone_at })) };
			}
			// via 'source': this upload's own print (an owner's edit).
			return ingest(b, record, r, extra);
		case 'new':
			return ingest(b, record, { ...r, printId }, extra);
	}
};

const ingest = async (b: AdmitBindings, record: SourceRecord, admission: Admission, extra: D1PreparedStatement[]): Promise<GateOutcome> => {
	let outcome;
	try {
		outcome = await Effect.runPromise(
			Effect.provide(ingestRecord(record, admission, { extra: () => extra }), Layer.mergeAll(RawStoreR2(b.RAW), PrintRepositoryD1(b.DB)))
		);
	} catch (e) {
		console.warn(`uploads: ${admission.printId} deferred to the sync: ${reasonOf(e)}`);
		return { status: 'deferred', reason: reasonOf(e) };
	}
	switch (outcome.status) {
		case 'analysed':
		case 'identified':
			return { status: 'admitted', printId: admission.printId, suggestions: admission.admitted.suggestions };
		// An approved removal: its print, or new content it blocks (the `prints_not_removed` trigger included).
		case 'removed':
		case 'blocked':
			return { status: 'blocked' };
		case 'failed':
		case 'skipped-failed':
			return { status: 'undecodable', reason: outcome.reason };
		default:
			// `extra` forces analysis, so nothing else is expected; the sync tries again.
			return { status: 'deferred', reason: `ingest answered ${outcome.status}` };
	}
};

/**
 * `meta.ingest_due`: when a hand-over last fell back to purging (unix ms). The sync's uploads source reports
 * it and the ingest key includes it, so the next update runs the backfill, which admits the next source's
 * record again as a print of its own.
 */
export const INGEST_DUE = 'ingest_due';

export const markIngestDue = (db: D1Database, now = Date.now()) =>
	db
		.prepare(`INSERT INTO meta (key, value) VALUES ('${INGEST_DUE}', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
		.bind(String(now))
		.run();

export const ingestDue = async (db: D1Database) =>
	(await db.prepare(`SELECT value FROM meta WHERE key = '${INGEST_DUE}'`).first<{ value: string }>())?.value ?? null;

/** What the gate needs: the pipeline's bindings and the purge's (the site Worker's env, or the cron Worker's). */
export type GateEnv = PipelineEnv & TakedownEnv;

/** The gate on this stage's bindings. */
export const workerGate = (env: GateEnv): UploadGate => {
	const layer = pipelineLayer(env);
	const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) => Effect.runPromise(Effect.provide(effect, layer));

	/**
	 * The print's next source took over: ingest it again from that source's record. A factorioprints
	 * record comes from the mirror (as `ingestPrint` fetches one); another site's from its RAW archive.
	 */
	const reingest = async (printId: string, winner: PrintSourceRow) => {
		let record: SourceRecord | null;
		if (winner.site === 'factorioprints') {
			const { text } = await run(
				Effect.gen(function* () {
					return yield* (yield* PrintSource).fetchRecord(winner.site_id);
				})
			);
			record = fromFactorioprints(winner.site_id, text);
		} else {
			const obj = await env.RAW.get(rawKeyFor(winner.site, winner.site_id));
			record = obj ? fromPipelineText(await obj.text()) : null;
		}
		if (!record) throw new Error(`no record for ${winner.site}:${winner.site_id}`);
		const r = await admitRecord(env.DB, record, { limits: WORKER_LIMITS });
		if (r.status !== 'existing' || r.printId !== printId) throw new Error(`${winner.site}:${winner.site_id} came out ${r.status}`);
		const outcome = await run(ingestRecord(record, r));
		if (outcome.status !== 'analysed' && outcome.status !== 'unchanged') throw new Error(`ingest answered ${outcome.status}`);
	};

	/** Whether the print's screenshot is its alone, so a 'gone' purge may take it (`screenshotToo`). */
	const ownImage = async (printId: string) =>
		(await env.DB.prepare(
			`SELECT 1 AS hit FROM prints p WHERE p.id = ?1 AND p.image_id IS NOT NULL
				AND NOT EXISTS (SELECT 1 FROM prints o WHERE o.image_id = p.image_id AND o.id != p.id)`
		)
			.bind(printId)
			.first()) !== null;

	return {
		admit: (record, printId, extra) => admitUpload(env, record, printId, extra, WORKER_LIMITS),
		sourceGone: async (siteId, extras) => {
			const purge = async (printId: string) =>
				purgePrintData(env, printId, { kind: 'gone', screenshotToo: await ownImage(printId), ...extras });
			const r = await sourceGone(env.DB, 'upload', siteId, {
				purge,
				// If the next source can't be ingested here (over the Worker's caps, the mirror unreachable), the
				// print goes; that source's next sync admits it again as a print of its own.
				reingest: (printId, winner) =>
					reingest(printId, winner).catch(async (e) => {
						console.warn(`uploads: ${printId} hand-over to ${winner.site}:${winner.site_id} failed, purged instead: ${reasonOf(e)}`);
						await purge(printId);
						await run(syncFold(printId));
						// The backfill admits that source again, but the sync skips it while nothing else changed.
						await markIngestDue(env.DB);
					}),
				refold: (printId) => run(syncFold(printId))
			});
			return r.status === 'purged' ? 'purged' : r.status === 'unknown' || r.status === 'already-gone' ? 'none' : 'kept';
		},
		imageBlocked: async (imageId) =>
			(await env.DB.prepare(`SELECT 1 AS hit FROM removal_blocks WHERE kind = 'image' AND value = ?`).bind(`upload.${imageId}`).first()) !==
			null
	};
};
