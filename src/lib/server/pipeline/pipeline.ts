import { Data, Effect, Schema } from 'effect';
import { ANALYZER_VERSION, analyzePrint, claimedPlanets, claimedVersions, type PrintAnalysis } from './analyze';
import { decodeExchangeString } from './decode';
import { REMOVED_ABORT } from '#lib/server/removal-blocks.js';
import { BlueprintDecodeError, RecordParseError, StorageError } from './errors';
import { gameData } from './game-data';
import type { Admission } from './admit';
import { fingerprintPrint, type PrintFingerprint } from './identity';
import type { FoldMember } from './fold';
import { blockHashes, docSourcesOf, withSourceRow, type PrintSourceRow } from './identity-db';
import { analysisKey, parsePrintDoc, toPrintDoc, withAuthorName, withFold, withSources } from './print-doc';
import { RawStore } from './raw-store';
import { FirebaseRecord, stripPrivateFields } from './record';
import {
	authorIdOf,
	INDEX_VERSION,
	PrintRepository,
	type FailedPrint,
	type Identity,
	type IngestState,
	type StoredPrint
} from './repository';
import { PrintSource } from './source';
import { pipelineText, rawKeyOfText, sourceMetaOf, sourceMetaOfRecord, type SourceRecord } from './source-record';
import { buildViewerFilesEffect, deleteViewerFiles, putViewerFiles, VIEWER_VERSION, type ViewerFiles } from './viewer-files';

const sha256 = (text: string) =>
	Effect.promise(async () => {
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
		return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
	});

/** Where a factorioprints record is archived; other sites' records go to `<site>/<siteId>.json` (source-record.ts). */
export const rawKey = (id: string) => `factorioprints/${id}.json`;

/** The author name a record carries itself: factorioprints' `displayName`, another site's author's name. */
const ownAuthorName = (record: FirebaseRecord) => record.author?.displayName || record.source?.author?.name || null;

/**
 * The name a print is credited to: its record's own author name, else the `authors` table's
 * (migration 0017; most records carry only the author's id, see `bun run authors`).
 */
const resolveAuthorName = Effect.fn('resolveAuthorName')(function* (record: FirebaseRecord) {
	const own = ownAuthorName(record);
	const authorId = authorIdOf(record);
	if (own || !authorId) return own;
	return yield* (yield* PrintRepository).authorName(authorId);
});

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
	/** Blocked by an approved removal (`removal_blocks`): nothing written. */
	| { readonly status: 'removed'; readonly id: string }
	/**
	 * New content an approved removal blocks (removed print `by`'s whole content, or one of its pages posted
	 * alone): nothing stored but a failed `ingest_state` row ('blocked: …'), so it's skipped until it changes.
	 */
	| { readonly status: 'blocked'; readonly id: string; readonly by: string }
	/**
	 * Nothing else to do but the identity rows a print ingested before migration 0022 lacked
	 * (`print_sources`, `print_fingerprints`): written alone, nothing the site shows changes.
	 */
	| { readonly status: 'identified'; readonly id: string }
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
	/**
	 * The text is `toPipelineText`'s (another site's record, via `ingestRecord`), so its `source` key is ours
	 * and kept. Any other text's `source` is dropped: a factorioprints record never names its own site.
	 */
	readonly sourceRecord?: boolean;
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

/** A record decoded and fingerprinted already (admit.ts), so ingesting it doesn't do it again. */
export interface Predecoded {
	readonly decoded: unknown;
	readonly fingerprint: PrintFingerprint;
}

/** Parse the record and inflate its blueprint string (unless `pre` has it). */
const decodePayload = (id: string, text: string, options: IngestOptions, pre?: Predecoded) =>
	Effect.gen(function* () {
		const record = yield* decodeRecord(id, text);
		const decoded = pre ? pre.decoded : yield* decodeExchangeString(record.blueprintString, { maxInflatedBytes: options.maxInflatedBytes });
		return { record, decoded };
	});

/** The print's identity rows to write: its source and content fingerprints (identity.ts). */
const identityOf = (id: string, record: FirebaseRecord, decoded: unknown, pre?: Predecoded) =>
	Effect.promise(async (): Promise<Identity> => ({
		source: sourceMetaOf(id, record),
		fingerprint: pre?.fingerprint ?? (await fingerprintPrint(decoded))
	}));

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
	 * Analysis up to date: new favourites count, rebuilt viewer files (VIEWER_VERSION bump), the D1
	 * rows rewritten from the stored analysis (INDEX_VERSION bump) and/or the identity rows a print
	 * ingested before migration 0022 lacks.
	 */
	| {
			readonly kind: 'refresh';
			readonly id: string;
			readonly favorites: number | null;
			readonly viewerFiles: ViewerFiles | null;
			readonly reindex: Reindex | null;
			readonly identity: Identity | null;
	  }
	/** `archive` is the sanitised record to store at `rawKey` (the record's archive key), when its content changed. */
	| {
			readonly kind: 'failed';
			readonly id: string;
			readonly archive: string | null;
			readonly rawKey: string;
			readonly failure: FailedPrint;
	  }
	| {
			readonly kind: 'analysed';
			readonly id: string;
			readonly archive: string | null;
			/** null when the stored viewer files are already current. */
			readonly viewerFiles: ViewerFiles | null;
			/** The R2 analysis document (`analysisKey`). */
			readonly doc: string;
			/**
			 * Check `removal_blocks` for its content hashes first: only a print not stored before (no
			 * `ingest_state`). A live print that later matches a block (a compilation holding a page of a
			 * removed book) is ingested as usual; taking it down is the admin's call.
			 */
			readonly checkBlocks: boolean;
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
	e: RecordParseError | BlueprintDecodeError | AnalyzeError,
	key: string
): IngestPlan => ({ kind: 'failed', id, archive, rawKey: key, failure: { id, contentSha256, reason: failureReason(e), favorites } });

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
	archive: string | null,
	pre?: Predecoded
): Effect.fn.Return<IngestPlan, StorageError> {
	const { contentSha256, favorites } = yield* fingerprint(id, text).pipe(
		Effect.catch(() => Effect.succeed({ contentSha256: 'unparseable', favorites: 0 }))
	);
	const key = rawKeyOfText(id, text);
	const analysed = yield* Effect.gen(function* () {
		const { record, decoded } = yield* decodePayload(id, text, options, pre);
		const base = yield* Effect.try({ try: () => analyzePrint(decoded), catch: (cause) => new AnalyzeError({ cause }) });
		return { record, decoded, base };
	}).pipe(Effect.result);
	if (analysed._tag === 'Failure') return failedPlan(id, archive, contentSha256, favorites, analysed.failure, key);
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
		checkBlocks: previous === null,
		print: {
			id,
			sourceUrl,
			rawKey: key,
			rawSha256: yield* sha256(text),
			contentSha256,
			record,
			analysis,
			viewerVersion: VIEWER_VERSION,
			// The record's own; applyPlan looks up the rest.
			authorName: ownAuthorName(record),
			identity: yield* identityOf(id, record, decoded, pre)
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
	options: IngestOptions = {},
	pre?: Predecoded
): Effect.fn.Return<IngestPlan, RecordParseError | StorageError> {
	const clean = yield* sanitizeRaw(id, text, options.sourceRecord === true);
	const { contentSha256, favorites } = yield* fingerprint(id, clean);
	const same = state?.contentSha256 === contentSha256;
	if (state && same && !options.force) {
		if (state.status === 'failed' && !options.retryFailed && !retryable(state.reason)) {
			return { kind: 'skipped-failed', id, reason: state.reason ?? '' };
		}
		if (state.status === 'ok' && state.analyzerVersion === ANALYZER_VERSION && state.gameDataVersion === gameData.gameVersion) {
			let viewerFiles: ViewerFiles | null = null;
			let identity: Identity | null = null;
			const staleViewer = state.viewerVersion !== VIEWER_VERSION;
			// Only false when the loader knows (getState, loadIngestStates); a record without its identity rows gets them once.
			if (staleViewer || state.identified === false) {
				const payload = yield* decodePayload(id, clean, options, pre).pipe(Effect.result);
				if (payload._tag === 'Success') {
					if (staleViewer) viewerFiles = yield* buildViewerFilesEffect(id, payload.success.decoded);
					if (state.identified === false) identity = yield* identityOf(id, payload.success.record, payload.success.decoded, pre);
				} else if (staleViewer) return failedPlan(id, null, contentSha256, favorites, payload.failure, rawKeyOfText(id, clean));
				// A print the site shows never leaves it for want of identity rows (e.g. under a smaller decode cap).
			}
			const favoritesChanged = state.favorites !== favorites;
			const staleIndex: Reindex | null =
				state.indexVersion === INDEX_VERSION
					? null
					: { text: clean, sourceUrl, rawSha256: yield* sha256(clean), contentSha256, maxInflatedBytes: options.maxInflatedBytes };
			if (viewerFiles === null && !favoritesChanged && staleIndex === null && identity === null) return { kind: 'unchanged', id };
			return { kind: 'refresh', id, favorites: favoritesChanged ? favorites : null, viewerFiles, reindex: staleIndex, identity };
		}
	}
	// The archived copy only needs rewriting when the content changed (favourites live in D1).
	return yield* planAnalysis(id, clean, sourceUrl, state, options, same ? null : clean, pre);
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
		rawKey: rawKeyOfText(id, clean),
		failure: { id, contentSha256, reason, favorites }
	};
	return plan;
});

/** The `prints_not_removed` trigger (migration 0021) refused the print's row: an approval landed mid-run. */
const isRemovedAbort = (e: StorageError) => {
	const cause = e.cause instanceof Error ? e.cause.message : String(e.cause);
	return cause.includes(REMOVED_ABORT);
};

/**
 * Undo the R2 writes of a plan whose print turned out to be removed, so no page can read them. `archive`:
 * the record's archive key when the plan wrote it (`print.rawKey`: another site's records aren't at `rawKey`).
 */
const forgetWrites = Effect.fn('forgetWrites')(function* (id: string, archive: string | null) {
	const raw = yield* RawStore;
	yield* raw.delete(analysisKey(id));
	if (archive !== null) yield* raw.delete(archive);
	yield* deleteViewerFiles(id);
	return { status: 'removed', id } satisfies IngestOutcome;
});

/**
 * `repo.upsert`, answering 'removed' (and deleting what the plan put in R2) when the database refuses a
 * print an approved removal blocks. The trigger is the check: it costs no extra query per print, and it
 * also catches an approval that lands between the plan's R2 writes and its D1 batch. One that lands after
 * the batch is the takedown's to clean up: it deletes R2 and the rows after writing its blocks.
 */
const upsertUnlessRemoved = (print: Parameters<PrintRepository['Service']['upsert']>[0], extra: readonly D1PreparedStatement[]) =>
	Effect.gen(function* () {
		const repo = yield* PrintRepository;
		return yield* repo.upsert(print, extra).pipe(
			Effect.map((rows) => ({ removed: false as const, rows })),
			Effect.catchIf(isRemovedAbort, () => Effect.succeed({ removed: true as const, rows: 0 }))
		);
	});

export interface ApplyOptions {
	/**
	 * More D1 statements for the batch that writes the print's rows (an upload's own row), run only when
	 * the plan writes them ('analysed'). Built when needed, so a plan that writes nothing prepares none.
	 */
	readonly extra?: () => readonly D1PreparedStatement[];
	/**
	 * Hand over the soft-fold recompute (fold.ts) instead of doing it now: a run with several writers in
	 * flight (the backfill) collects the prints it touched and refolds them one at a time at its end
	 * (`syncFold` with `bump: false`), as two writers folding one group at once could leave it stale.
	 */
	readonly foldLater?: (id: string) => void;
}

/**
 * Store what `planIngest` computed. Writes go R2 first and D1 last, so `ingest_state` never claims
 * files that weren't written: archive, viewer files, analysis document, then the D1 batch. A print an
 * approved removal blocks is never kept, whichever path planned it: the database refuses its row
 * (migration 0021's trigger) and the plan's R2 writes are undone ('removed').
 */
export const applyPlan = Effect.fn('applyPlan')(function* (
	plan: IngestPlan,
	options: ApplyOptions = {}
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
			// Identity rows alone change nothing the site shows; the print is already live, so no block check.
			if (plan.identity) {
				yield* repo.identify(id, plan.identity);
				// A print without identity rows had no source row, so this is its only one: the document needs a
				// list only when it isn't the site the print's id names.
				if (docSourcesOf(id, withSourceRow(id, [], plan.identity.source)) !== undefined) yield* syncSources(id);
				yield* fold(id, options);
			}
			if (plan.reindex) return yield* reindex(id, plan.reindex, plan.favorites, plan.viewerFiles, options);
			if (!plan.viewerFiles && plan.favorites === null) return { status: 'identified', id };
			if (plan.viewerFiles) {
				yield* putViewerFiles(id, plan.viewerFiles);
				yield* repo.setViewerVersion(id, VIEWER_VERSION);
			}
			if (plan.favorites !== null) {
				const favorites = plan.favorites;
				yield* repo.updateFavorites(id, favorites);
				// The print page shows favourites from its R2 document, so patch that too.
				const doc = parsePrintDoc(yield* raw.get(analysisKey(id)));
				if (doc) {
					yield* raw.put(analysisKey(id), JSON.stringify({ ...doc, print: { ...doc.print, favorites } }));
					// No row is inserted here, so the trigger can't refuse it: look again, as a takedown since the
					// read would have its document back (only prints whose favourites changed pay for this).
					if (yield* repo.isRemoved(id)) return yield* forgetWrites(id, null);
				}
			}
			if (plan.viewerFiles) return { status: 'viewer', id, viewerFiles: plan.viewerFiles.size };
			return { status: 'favorites', id, favorites: plan.favorites ?? 0 };
		}
		case 'failed':
			if (plan.archive !== null) yield* raw.put(plan.rawKey, plan.archive);
			yield* repo.recordFailure(plan.failure);
			// The print and viewer pages read these, so a print that stopped decoding leaves the site.
			yield* raw.delete(analysisKey(id));
			yield* deleteViewerFiles(id);
			yield* fold(id, options);
			return { status: 'failed', id, reason: plan.failure.reason };
		case 'analysed': {
			// New content an approved removal blocks (a page of a removed book, under any id) is never stored.
			const identity = plan.print.identity;
			const by = plan.checkBlocks && identity ? yield* repo.blocked(identity.source, blockHashes(identity.fingerprint)) : null;
			// Its own removal: the print itself, nothing written (as the trigger would refuse it).
			if (by === id) return { status: 'removed', id };
			if (by !== null) {
				const reason = `blocked: the same blueprint as removed print ${by}`;
				yield* repo.recordFailure({
					id,
					contentSha256: plan.print.contentSha256,
					reason,
					favorites: plan.print.record.numberOfFavorites ?? 0
				});
				return { status: 'blocked', id, by };
			}
			const current = yield* repo.docState(id);
			// First upload wins, whichever path planned it: a record posted after another live source of the
			// print (the backfill's factorioprints copy of a print another site brought first) adds only its
			// source row and hashes, and leaves the shown record alone, as ingestRecord does.
			if (identity && postedLater(identity.source, current.sources)) {
				yield* repo.identify(id, identity, options.extra?.() ?? []);
				yield* syncSources(id);
				return { status: 'identified', id };
			}
			if (plan.archive !== null) yield* raw.put(plan.print.rawKey, plan.archive);
			const viewerFiles = plan.viewerFiles ? yield* putViewerFiles(id, plan.viewerFiles) : 0;
			const authorName = yield* resolveAuthorName(plan.print.record);
			// The fold its row has now goes into the document's first write; `fold` puts right what changed. So do
			// its sources, as they will be once the upsert's batch writes this record's row.
			const sources = identity ? withSourceRow(id, current.sources, identity.source) : current.sources;
			const doc = withSources(withFold(withAuthorName(plan.doc, authorName), current.fold), docSourcesOf(id, sources));
			yield* raw.put(analysisKey(id), doc);
			const stored = yield* upsertUnlessRemoved({ ...plan.print, authorName }, options.extra?.() ?? []);
			if (stored.removed) return yield* forgetWrites(id, plan.archive === null ? null : plan.print.rawKey);
			yield* fold(id, options);
			const { record, analysis } = plan.print;
			return { status: 'analysed', id, title: record.title, analysis, rowsWritten: stored.rows, viewerFiles };
		}
	}
});

/**
 * Recompute the soft-fold groups a print touches (fold.ts) after its rows changed or went: the changed
 * prints' R2 documents first, then their D1 rows (and with `bump` the page cache), so a page cached under
 * a new version always agrees. With `recheck`, every member's document is compared, changed or not (a
 * document written by an older build). One D1 batch when the print is in no group.
 */
export const syncFold = Effect.fn('syncFold')(function* (
	id: string,
	{ bump = true, recheck = false }: { bump?: boolean; recheck?: boolean } = {}
) {
	const repo = yield* PrintRepository;
	const members = yield* repo.planFold(id);
	yield* writeFolds(members, { bump, recheck });
	return members.filter((m) => m.changed).length;
});

/**
 * Every soft-fold group in the stage, recomputed from scratch and written where it differs (`bun run fold`,
 * and the end of a backfill run). Returns the members, `changed` marking what was (or with `dryRun` would be) written.
 */
export const refoldAll = Effect.fn('refoldAll')(function* ({
	bump,
	recheck = false,
	dryRun = false
}: {
	bump: boolean;
	recheck?: boolean;
	dryRun?: boolean;
}) {
	const members = yield* (yield* PrintRepository).planAllFolds();
	const documents = dryRun ? 0 : yield* writeFolds(members, { bump, recheck });
	return { members, documents };
});

/** The documents of `members` (changed ones, or all with `recheck`), then the D1 rows. Returns the documents written. */
export const writeFolds = Effect.fn('writeFolds')(function* (
	members: readonly FoldMember[],
	{ bump, recheck = false }: { bump: boolean; recheck?: boolean }
) {
	const repo = yield* PrintRepository;
	const raw = yield* RawStore;
	let documents = 0;
	for (const m of members) {
		if (!m.changed && !recheck) continue;
		const text = yield* raw.get(analysisKey(m.printId));
		if (text === null) continue;
		const next = withFold(text, m);
		if (next !== text) {
			yield* raw.put(analysisKey(m.printId), next);
			documents++;
		}
	}
	yield* repo.applyFold(members, bump);
	return documents;
});

/**
 * Bring a print's R2 document's sources list (`PrintDoc.print.sources`) up to date with `print_sources`,
 * after a source joined the print or went without the document being rewritten, and with `bump` purge the
 * page cache when it changed. Reads one D1 query and one R2 object; writes only when the list differs.
 * Returns whether it wrote. A print with no document (not stored, or purged) is left alone.
 */
export const syncSources = Effect.fn('syncSources')(function* (id: string, { bump = true }: { bump?: boolean } = {}) {
	const repo = yield* PrintRepository;
	const raw = yield* RawStore;
	const text = yield* raw.get(analysisKey(id));
	if (text === null) return false;
	const next = withSources(text, docSourcesOf(id, yield* repo.sources(id)));
	if (next === text) return false;
	yield* raw.put(analysisKey(id), next);
	// As the favourites patch: a takedown since the read would have its document back.
	if (yield* repo.isRemoved(id)) {
		yield* raw.delete(analysisKey(id));
		return false;
	}
	if (bump) yield* repo.bumpPages();
	return true;
});

/** Refold now, or hand the print to the run's `foldLater`. */
const fold = (id: string, options: ApplyOptions) =>
	options.foldLater ? Effect.sync(() => options.foldLater!(id)) : syncFold(id).pipe(Effect.asVoid);

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
	viewer: ViewerFiles | null,
	options: ApplyOptions = {}
): Effect.fn.Return<IngestOutcome, StorageError, PrintRepository | RawStore> {
	const raw = yield* RawStore;
	const doc = parsePrintDoc(yield* raw.get(analysisKey(id)));
	if (!doc || doc.analysis.analyzerVersion !== ANALYZER_VERSION || doc.analysis.gameDataVersion !== gameData.gameVersion) {
		const plan = yield* planAnalysis(id, r.text, r.sourceUrl, null, { maxInflatedBytes: r.maxInflatedBytes }, null);
		// A live print: never refused for a block (see `checkBlocks`).
		return yield* applyPlan(plan.kind === 'analysed' ? { ...plan, checkBlocks: false } : plan, options);
	}
	const record = yield* decodeRecord(id, r.text).pipe(Effect.mapError((cause) => new StorageError({ op: `reindex ${id}`, cause })));
	const viewerFiles = viewer ? yield* putViewerFiles(id, viewer) : 0;
	const authorName = (yield* resolveAuthorName(record)) ?? doc.print.author_name;
	if (favorites !== null || authorName !== doc.print.author_name) {
		const print = { ...doc.print, favorites: favorites ?? doc.print.favorites, author_name: authorName };
		yield* raw.put(analysisKey(id), JSON.stringify({ ...doc, print }));
	}
	const stored = yield* upsertUnlessRemoved(
		{
			id,
			sourceUrl: r.sourceUrl,
			rawKey: rawKeyOfText(id, r.text),
			rawSha256: r.rawSha256,
			contentSha256: r.contentSha256,
			record,
			analysis: doc.analysis,
			viewerVersion: VIEWER_VERSION,
			authorName,
			// Written by the plan already, when it had any to write.
			identity: null
		},
		[]
	);
	// It wrote no archive.
	if (stored.removed) return yield* forgetWrites(id, null);
	return { status: 'reindexed', id, rowsWritten: stored.rows, viewerFiles };
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

/** `stripPrivateFields` as an Effect: drop `favorites`, `image.deletehash` (and an untrusted `source`) before anything is stored. */
export const sanitizeRaw = (id: string, text: string, keepSource = false) =>
	Effect.try({ try: () => stripPrivateFields(text, keepSource), catch: (cause) => new RecordParseError({ id, cause }) });

/**
 * sanitize → (skip if unchanged) → archive raw → parse → decode → analyze → store: `planIngest`,
 * then `applyPlan`. Re-runs are cheap: an unchanged record writes nothing, a favourites-only change
 * writes two small rows, and a record that failed before is skipped until it changes (or a newer
 * analyzer might help).
 */
export const ingestText = Effect.fn('ingestText')(function* (id: string, text: string, sourceUrl: string, options: IngestOptions = {}) {
	// One print at a time (`bun run ingest`): a lookup first saves the work. The backfill leaves blocked
	// prints out of its listing instead, and the database refuses any that slip through.
	if (yield* (yield* PrintRepository).isRemoved(id)) return { status: 'removed', id } satisfies IngestOutcome;
	const state = yield* (yield* PrintRepository).getState(id);
	return yield* applyPlan(yield* planIngest(id, text, sourceUrl, state, options));
});

/** download, then `ingestText`. A removed print isn't even fetched. */
export const ingestPrint = Effect.fn('ingestPrint')(function* (id: string, options: IngestOptions = {}) {
	if (yield* (yield* PrintRepository).isRemoved(id)) return { status: 'removed', id } satisfies IngestOutcome;
	const source = yield* PrintSource;
	const { text, url } = yield* source.fetchRecord(id);
	yield* Effect.logInfo(`fetched ${id} (${text.length} bytes) from ${url}`);
	return yield* ingestText(id, text, url, options);
});

/** Re-run analysis over an already archived record, e.g. after bumping ANALYZER_VERSION. */
export const reanalyzePrint = Effect.fn('reanalyzePrint')(function* (id: string, options: IngestOptions = {}) {
	if (yield* (yield* PrintRepository).isRemoved(id)) return { status: 'removed', id } satisfies IngestOutcome;
	const raw = yield* RawStore;
	const text = yield* raw.get(rawKey(id));
	if (text === null) return yield* Effect.fail(new RecordParseError({ id, cause: 'not in raw store' }));
	return yield* processRaw(id, text, `raw:${rawKey(id)}`, yield* (yield* PrintRepository).getState(id), options);
});

/**
 * Whether another live source of the print was posted before this one (`uploaded_at`, else first seen; a
 * source that doesn't say when counts as posted now): then it, not this one, is the record the print shows.
 */
export const postedLater = (
	source: { readonly site: string; readonly siteId: string; readonly uploadedAt: number | null },
	sources: readonly PrintSourceRow[]
) => {
	const posted = source.uploadedAt ?? Date.now();
	return sources.some(
		(s) => s.gone_at === null && !(s.site === source.site && s.site_id === source.siteId) && (s.uploaded_at ?? s.first_seen) < posted
	);
};

export interface IngestRecordOptions extends IngestOptions, ApplyOptions {
	/** `prints.source_url`: defaults to the record's own page. */
	readonly sourceUrl?: string;
}

/**
 * Ingest a record admitted by `admitRecord` (admit.ts) into its print: the same plan and writes as the
 * backfill (analysis, viewer files, the R2 document, D1 rows, `print_sources`, `print_fingerprints`),
 * without decoding or fingerprinting again. Runs in the Worker (uploads) and in Bun.
 *
 * First upload wins what is shown: when another live source of the print was posted before this record,
 * only the record's source row and hashes are written ('identified'), whatever the caller expected. With
 * `extra` statements they go in the same batch as whatever is written, and the record is analysed even
 * when unchanged; the outcome is 'analysed' or 'identified' unless analysis fails ('failed': nothing of
 * `extra` written) or new content is blocked ('removed').
 */
export const ingestRecord = Effect.fn('ingestRecord')(function* (
	record: SourceRecord,
	admission: Admission,
	options: IngestRecordOptions = {}
) {
	const repo = yield* PrintRepository;
	const { printId, admitted } = admission;
	if (postedLater(record, yield* repo.sources(printId))) {
		yield* repo.identify(printId, { source: sourceMetaOfRecord(record), fingerprint: admitted.fingerprint }, options.extra?.() ?? []);
		// The print's page lists its sources ("Also on …").
		yield* syncSources(printId);
		return { status: 'identified', id: printId } satisfies IngestOutcome;
	}
	const state = yield* repo.getState(printId);
	const plan = yield* planIngest(
		printId,
		pipelineText(record),
		options.sourceUrl ?? record.url,
		state,
		{ ...options, sourceRecord: record.site !== 'factorioprints', ...(options.extra ? { force: true } : {}) },
		admitted
	);
	return yield* applyPlan(plan, options);
});
