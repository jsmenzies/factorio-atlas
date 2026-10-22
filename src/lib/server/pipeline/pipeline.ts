import { Data, Effect, Schema } from 'effect';
import { ANALYZER_VERSION, analyzePrint, claimedPlanets, claimedVersions, type PrintAnalysis } from './analyze';
import { decodeExchangeString } from './decode';
import { BlueprintDecodeError, RecordParseError, StorageError } from './errors';
import { gameData } from './game-data';
import { analysisKey, parsePrintDoc, toPrintDoc } from './print-doc';
import { RawStore } from './raw-store';
import { FirebaseRecord, stripPrivateFields } from './record';
import { INDEX_VERSION, PrintRepository, type FailedPrint, type IngestState, type StoredPrint } from './repository';
import { PrintSource } from './source';
import { buildViewerFilesEffect, deleteViewerFiles, putViewerFiles, VIEWER_VERSION, type ViewerFiles } from './viewer-files';

const sha256 = (text: string) =>
	Effect.promise(async () => {
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
		return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
	});

export const rawKey = (id: string) => `factorioprints/${id}.json`;

const decodeRecord = (id: string, text: string) =>
	Schema.decodeUnknownEffect(Schema.fromJsonString(FirebaseRecord))(text).pipe(
		Effect.mapError((cause) => new RecordParseError({ id, cause }))
	);

/** Why a record can't be analysed. The prefix says whether a new analyzer could ever help. */
export class AnalyzeError extends Data.TaggedError('AnalyzeError')<{ readonly cause: unknown }> {}

export type IngestOutcome =
	| {
			readonly status: 'analysed';
			readonly id: string;
			readonly title: string;
			readonly analysis: PrintAnalysis;
			readonly rowsWritten: number;
			/** R2 viewer objects written; 0 when they were already up to date. */
			readonly viewerFiles: number;
	  }
	/** Couldn't parse, decode or analyse; tracked in `ingest_state` and skipped until it changes. */
	| { readonly status: 'failed'; readonly id: string; readonly reason: string }
	| { readonly status: 'skipped-failed'; readonly id: string; readonly reason: string }
	/** Nothing changed since the last run: no writes at all. */
	| { readonly status: 'unchanged'; readonly id: string }
	/** Only the favourites count changed: one small update, no re-analysis. */
	| { readonly status: 'favorites'; readonly id: string; readonly favorites: number }
	/** Only the viewer files were stale (VIEWER_VERSION bump): rebuilt them, no re-analysis or D1 analysis writes. */
	| { readonly status: 'viewer'; readonly id: string; readonly viewerFiles: number }
	/**
	 * Only the D1 rows were stale (INDEX_VERSION bump): rewrote them from the R2 analysis document, with no
	 * re-analysis. `viewerFiles` > 0 when a VIEWER_VERSION bump rebuilt those in the same pass.
	 */
	| { readonly status: 'reindexed'; readonly id: string; readonly rowsWritten: number; readonly viewerFiles: number };

export interface IngestOptions {
	/** Re-analyse even when nothing changed. */
	readonly force?: boolean;
	/** Retry records that failed before, even though they haven't changed. */
	readonly retryFailed?: boolean;
	/** Offline runs raise the zip-bomb cap (`OFFLINE_MAX_INFLATED_BYTES`). */
	readonly maxInflatedBytes?: number;
}

/**
 * The record's identity for change detection: sha256 of the sanitised JSON without
 * `numberOfFavorites`, which the mirror updates far more often than anything else.
 */
export const fingerprint = (id: string, clean: string) =>
	Effect.gen(function* () {
		const record = yield* Effect.try({
			try: () => JSON.parse(clean) as Record<string, unknown>,
			catch: (cause) => new RecordParseError({ id, cause })
		});
		const favorites = typeof record.numberOfFavorites === 'number' ? record.numberOfFavorites : 0;
		delete record.numberOfFavorites;
		return { contentSha256: yield* sha256(JSON.stringify(record)), favorites };
	});

/**
 * A failure is retried only when a newer analyzer might succeed: decode and parse failures
 * (corrupt strings, the 0.14 Lua-table format) stay skipped until the record itself changes.
 */
const failureReason = (e: RecordParseError | BlueprintDecodeError | AnalyzeError) =>
	e._tag === 'RecordParseError'
		? 'parse: record does not match the schema'
		: e._tag === 'BlueprintDecodeError'
			? `decode: ${e.reason}`
			: `analyze v${ANALYZER_VERSION}: ${e.cause instanceof Error ? e.cause.message : String(e.cause)}`;

const retryable = (reason: string | null) =>
	reason?.startsWith(`analyze v`) === true && !reason.startsWith(`analyze v${ANALYZER_VERSION}:`);

/** Parse the record and inflate its blueprint string. */
const decodePayload = (id: string, text: string, options: IngestOptions) =>
	Effect.gen(function* () {
		const record = yield* decodeRecord(id, text);
		const decoded = yield* decodeExchangeString(record.blueprintString, { maxInflatedBytes: options.maxInflatedBytes });
		return { record, decoded };
	});

/**
 * What `applyPlan` must write for one record. `planIngest` computes it without touching D1 or R2
 * (sanitise, fingerprint, decode, analyse, build the viewer files and the R2 document), so the
 * CPU-heavy part can run in a worker that is killed when a print takes too long. It is plain data
 * (structured-cloneable) for that reason.
 */
export type IngestPlan =
	| { readonly kind: 'skipped-failed'; readonly id: string; readonly reason: string }
	| { readonly kind: 'unchanged'; readonly id: string }
	/**
	 * Analysis up to date: new favourites count, rebuilt viewer files (VIEWER_VERSION bump) and/or the D1
	 * rows rewritten from the stored analysis (INDEX_VERSION bump).
	 */
	| {
			readonly kind: 'refresh';
			readonly id: string;
			readonly favorites: number | null;
			readonly viewerFiles: ViewerFiles | null;
			readonly reindex: Reindex | null;
	  }
	/** `archive` is the sanitised record to store at `rawKey`, when its content changed. */
	| { readonly kind: 'failed'; readonly id: string; readonly archive: string | null; readonly failure: FailedPrint }
	| {
			readonly kind: 'analysed';
			readonly id: string;
			readonly archive: string | null;
			/** null when the stored viewer files are already current. */
			readonly viewerFiles: ViewerFiles | null;
			/** The R2 analysis document (`analysisKey`). */
			readonly doc: string;
			readonly print: StoredPrint;
	  };

/** What rewriting a print's D1 rows needs besides its R2 analysis document: the sanitised record. */
export interface Reindex {
	readonly text: string;
	readonly sourceUrl: string;
	readonly rawSha256: string;
	readonly contentSha256: string;
	/** The run's decode cap, for the full analysis a missing or stale document falls back to. */
	readonly maxInflatedBytes?: number;
}

const failedPlan = (
	id: string,
	archive: string | null,
	contentSha256: string,
	favorites: number,
	e: RecordParseError | BlueprintDecodeError | AnalyzeError
): IngestPlan => ({ kind: 'failed', id, archive, failure: { id, contentSha256, reason: failureReason(e), favorites } });

/**
 * The analysis half of the plan: parse, decode, analyse, and build what to store. `previous` is the
 * record's `ingest_state` row: the viewer files are rebuilt only when they're stale or the content
 * changed (or with `force`).
 */
const planAnalysis = Effect.fn('planAnalysis')(function* (
	id: string,
	text: string,
	sourceUrl: string,
	previous: IngestState | null,
	options: IngestOptions,
	archive: string | null
): Effect.fn.Return<IngestPlan, StorageError> {
	const { contentSha256, favorites } = yield* fingerprint(id, text).pipe(
		Effect.catch(() => Effect.succeed({ contentSha256: 'unparseable', favorites: 0 }))
	);
	const analysed = yield* Effect.gen(function* () {
		const { record, decoded } = yield* decodePayload(id, text, options);
		const base = yield* Effect.try({ try: () => analyzePrint(decoded), catch: (cause) => new AnalyzeError({ cause }) });
		return { record, decoded, base };
	}).pipe(Effect.result);
	if (analysed._tag === 'Failure') return failedPlan(id, archive, contentSha256, favorites, analysed.failure);
	const { record, decoded, base } = analysed.success;
	// Site tags look like "/version/0,17/".
	const tagVersions = (record.tags ?? []).flatMap(
		(t) =>
			t
				.match(/^\/version\/(\d+),(\d+)\/$/)
				?.slice(1, 3)
				.join('.') ?? []
	);
	const analysis = {
		...base,
		claimedVersions: [
			...new Set([...base.claimedVersions, ...claimedVersions(record.title, record.descriptionMarkdown), ...tagVersions])
		].sort((a, b) => Number(a) - Number(b)),
		claimedPlanets: [...new Set([...base.claimedPlanets, ...claimedPlanets(record.title, record.descriptionMarkdown)])].sort()
	};
	const viewerFresh =
		!options.force && previous?.status === 'ok' && previous.contentSha256 === contentSha256 && previous.viewerVersion === VIEWER_VERSION;
	return {
		kind: 'analysed',
		id,
		archive,
		viewerFiles: viewerFresh ? null : yield* buildViewerFilesEffect(id, decoded),
		doc: JSON.stringify(toPrintDoc(id, sourceUrl, record, analysis)),
		print: {
			id,
			sourceUrl,
			rawKey: rawKey(id),
			rawSha256: yield* sha256(text),
			contentSha256,
			record,
			analysis,
			viewerVersion: VIEWER_VERSION
		}
	};
});

/**
 * Decide what to do with a record and compute everything to store, without touching D1 or R2.
 * `state` is its `ingest_state` row. Change key: content (`fingerprint`), ANALYZER_VERSION, game
 * data version, VIEWER_VERSION and INDEX_VERSION.
 *
 * | analysis up to date | viewer files up to date | D1 index up to date | plan                                                  |
 * | yes                 | yes                     | yes                 | favourites-only update, or nothing                    |
 * | no                  | either                  | either              | re-analyse; rewrite viewer files if stale or changed  |
 * | yes                 | no                      | either              | rebuild viewer files (+ D1 rows if stale)             |
 * | yes                 | yes                     | no                  | rewrite the D1 rows from the R2 analysis document     |
 */
export const planIngest = Effect.fn('planIngest')(function* (
	id: string,
	text: string,
	sourceUrl: string,
	state: IngestState | null,
	options: IngestOptions = {}
): Effect.fn.Return<IngestPlan, RecordParseError | StorageError> {
	const clean = yield* sanitizeRaw(id, text);
	const { contentSha256, favorites } = yield* fingerprint(id, clean);
	const same = state?.contentSha256 === contentSha256;
	if (state && same && !options.force) {
		if (state.status === 'failed' && !options.retryFailed && !retryable(state.reason)) {
			return { kind: 'skipped-failed', id, reason: state.reason ?? '' };
		}
		if (state.status === 'ok' && state.analyzerVersion === ANALYZER_VERSION && state.gameDataVersion === gameData.gameVersion) {
			let viewerFiles: ViewerFiles | null = null;
			if (state.viewerVersion !== VIEWER_VERSION) {
				const payload = yield* decodePayload(id, clean, options).pipe(Effect.result);
				if (payload._tag === 'Failure') return failedPlan(id, null, contentSha256, favorites, payload.failure);
				viewerFiles = yield* buildViewerFilesEffect(id, payload.success.decoded);
			}
			const favoritesChanged = state.favorites !== favorites;
			const staleIndex: Reindex | null =
				state.indexVersion === INDEX_VERSION
					? null
					: { text: clean, sourceUrl, rawSha256: yield* sha256(clean), contentSha256, maxInflatedBytes: options.maxInflatedBytes };
			if (viewerFiles === null && !favoritesChanged && staleIndex === null) return { kind: 'unchanged', id };
			return { kind: 'refresh', id, favorites: favoritesChanged ? favorites : null, viewerFiles, reindex: staleIndex };
		}
	}
	// The archived copy only needs rewriting when the content changed (favourites live in D1).
	return yield* planAnalysis(id, clean, sourceUrl, state, options, same ? null : clean);
});

/**
 * A failure decided outside `planIngest`, e.g. a backfill timeout (reason `timeout: …`): tracked in
 * `ingest_state` like any failure, so the record is skipped until its content changes.
 */
export const planFailure = Effect.fn('planFailure')(function* (id: string, text: string, state: IngestState | null, reason: string) {
	const clean = yield* sanitizeRaw(id, text);
	const { contentSha256, favorites } = yield* fingerprint(id, clean);
	const plan: IngestPlan = {
		kind: 'failed',
		id,
		archive: state?.contentSha256 === contentSha256 ? null : clean,
		failure: { id, contentSha256, reason, favorites }
	};
	return plan;
});

/**
 * Store what `planIngest` computed. Writes go R2 first and D1 last, so `ingest_state` never claims
 * files that weren't written: archive, viewer files, analysis document, then the D1 batch.
 */
export const applyPlan = Effect.fn('applyPlan')(function* (
	plan: IngestPlan
): Effect.fn.Return<IngestOutcome, StorageError, PrintRepository | RawStore> {
	const repo = yield* PrintRepository;
	const raw = yield* RawStore;
	const { id } = plan;
	switch (plan.kind) {
		case 'skipped-failed':
			return { status: 'skipped-failed', id, reason: plan.reason };
		case 'unchanged':
			return { status: 'unchanged', id };
		case 'refresh': {
			if (plan.reindex) return yield* reindex(id, plan.reindex, plan.favorites, plan.viewerFiles);
			if (plan.viewerFiles) {
				yield* putViewerFiles(id, plan.viewerFiles);
				yield* repo.setViewerVersion(id, VIEWER_VERSION);
			}
			if (plan.favorites !== null) {
				const favorites = plan.favorites;
				yield* repo.updateFavorites(id, favorites);
				// The print page shows favourites from its R2 document, so patch that too.
				const doc = parsePrintDoc(yield* raw.get(analysisKey(id)));
				if (doc) yield* raw.put(analysisKey(id), JSON.stringify({ ...doc, print: { ...doc.print, favorites } }));
			}
			if (plan.viewerFiles) return { status: 'viewer', id, viewerFiles: plan.viewerFiles.size };
			return { status: 'favorites', id, favorites: plan.favorites ?? 0 };
		}
		case 'failed':
			if (plan.archive !== null) yield* raw.put(rawKey(id), plan.archive);
			yield* repo.recordFailure(plan.failure);
			// The print and viewer pages read these, so a print that stopped decoding leaves the site.
			yield* raw.delete(analysisKey(id));
			yield* deleteViewerFiles(id);
			return { status: 'failed', id, reason: plan.failure.reason };
		case 'analysed': {
			if (plan.archive !== null) yield* raw.put(rawKey(id), plan.archive);
			const viewerFiles = plan.viewerFiles ? yield* putViewerFiles(id, plan.viewerFiles) : 0;
			yield* raw.put(analysisKey(id), plan.doc);
			const rowsWritten = yield* repo.upsert(plan.print);
			const { record, analysis } = plan.print;
			return { status: 'analysed', id, title: record.title, analysis, rowsWritten, viewerFiles };
		}
	}
});

/**
 * Rewrite a print's D1 rows (INDEX_VERSION bump) from its R2 analysis document, plus any viewer files
 * and favourites the same plan refreshes. Reads one R2 object and writes no R2 objects unless the
 * favourites changed. A missing or stale document (never expected for an 'ok' record) falls back to a
 * full analysis in this process.
 */
const reindex = Effect.fn('reindex')(function* (
	id: string,
	r: Reindex,
	favorites: number | null,
	viewer: ViewerFiles | null
): Effect.fn.Return<IngestOutcome, StorageError, PrintRepository | RawStore> {
	const raw = yield* RawStore;
	const doc = parsePrintDoc(yield* raw.get(analysisKey(id)));
	if (!doc || doc.analysis.analyzerVersion !== ANALYZER_VERSION || doc.analysis.gameDataVersion !== gameData.gameVersion) {
		return yield* applyPlan(yield* planAnalysis(id, r.text, r.sourceUrl, null, { maxInflatedBytes: r.maxInflatedBytes }, null));
	}
	const record = yield* decodeRecord(id, r.text).pipe(Effect.mapError((cause) => new StorageError({ op: `reindex ${id}`, cause })));
	const viewerFiles = viewer ? yield* putViewerFiles(id, viewer) : 0;
	if (favorites !== null) yield* raw.put(analysisKey(id), JSON.stringify({ ...doc, print: { ...doc.print, favorites } }));
	const rowsWritten = yield* (yield* PrintRepository).upsert({
		id,
		sourceUrl: r.sourceUrl,
		rawKey: rawKey(id),
		rawSha256: r.rawSha256,
		contentSha256: r.contentSha256,
		record,
		analysis: doc.analysis,
		viewerVersion: VIEWER_VERSION
	});
	return { status: 'reindexed', id, rowsWritten, viewerFiles };
});

/**
 * Analyze a sanitised record and store it; a record that can't be analysed is tracked as failed.
 * `previous` is its `ingest_state` row: the viewer files are rewritten only when they're stale or
 * the content changed (or with `force`).
 */
export const processRaw = Effect.fn('processRaw')(function* (
	id: string,
	text: string,
	sourceUrl: string,
	previous: IngestState | null,
	options: IngestOptions = {}
): Effect.fn.Return<IngestOutcome, StorageError, PrintRepository | RawStore> {
	return yield* applyPlan(yield* planAnalysis(id, text, sourceUrl, previous, options, null));
});

/** `stripPrivateFields` as an Effect: drop `favorites` and `image.deletehash` before anything is stored. */
export const sanitizeRaw = (id: string, text: string) =>
	Effect.try({ try: () => stripPrivateFields(text), catch: (cause) => new RecordParseError({ id, cause }) });

/**
 * sanitize → (skip if unchanged) → archive raw → parse → decode → analyze → store: `planIngest`,
 * then `applyPlan`. Re-runs are cheap: an unchanged record writes nothing, a favourites-only change
 * writes two small rows, and a record that failed before is skipped until it changes (or a newer
 * analyzer might help).
 */
export const ingestText = Effect.fn('ingestText')(function* (id: string, text: string, sourceUrl: string, options: IngestOptions = {}) {
	const state = yield* (yield* PrintRepository).getState(id);
	return yield* applyPlan(yield* planIngest(id, text, sourceUrl, state, options));
});

/** download, then `ingestText`. */
export const ingestPrint = Effect.fn('ingestPrint')(function* (id: string, options: IngestOptions = {}) {
	const source = yield* PrintSource;
	const { text, url } = yield* source.fetchRecord(id);
	yield* Effect.logInfo(`fetched ${id} (${text.length} bytes) from ${url}`);
	return yield* ingestText(id, text, url, options);
});

/** Re-run analysis over an already archived record, e.g. after bumping ANALYZER_VERSION. */
export const reanalyzePrint = Effect.fn('reanalyzePrint')(function* (id: string, options: IngestOptions = {}) {
	const raw = yield* RawStore;
	const text = yield* raw.get(rawKey(id));
	if (text === null) return yield* Effect.fail(new RecordParseError({ id, cause: 'not in raw store' }));
	return yield* processRaw(id, text, `raw:${rawKey(id)}`, yield* (yield* PrintRepository).getState(id), options);
});
