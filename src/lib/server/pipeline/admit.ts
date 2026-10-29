/**
 * The gate every record passes on its way in, from any site (plans/ingest-and-delete, "Ingestion"):
 *
 * 1. Its source ('<site>:<siteId>') blocked by an approved removal? Refused, before decoding.
 * 2. Decode and fingerprint every page (identity.ts). The Worker path caps the string and the
 *    entities + tiles (`WORKER_LIMITS`); past them the answer is 'too-big', for a Bun run to admit.
 * 3. The whole print's exact hash blocked? Refused: a removed print's content, or one of its pages posted
 *    alone (`blockHashes`). A book that merely holds such a page is not.
 * 4. A source we already have keeps its print ('existing' via 'source'), however its content changed.
 * 5. The whole print's exact hash on a live print, from JOIN_MIN_SIZE entities + tiles up: 'existing'
 *    via 'exact', the print whose live sources were posted first. factorioprints records are the
 *    exception: they keep their own ids (their URLs are factorioprints'), so a match among prints only
 *    factorioprints has is 'new' with `copyOf` (the soft fold, fold.ts), and only a print another site
 *    brought joins.
 * 6. Else 'new'.
 *
 * Every answer past decoding carries suggestions that never join: a small exact match, a layout match,
 * pages shared with another print (counted both ways, so a compilation book holding the print doesn't
 * read as a copy). Blocks never show as suggestions.
 *
 * Reads D1, writes nothing: the caller passes a 'new' (with the id it chose) or 'existing' answer to
 * `ingestRecord` (pipeline.ts), which shows the record only when it was posted before every other live
 * source of the print (first upload wins); a later one adds only its source row and hashes. Two identical
 * records admitted at the same moment can both come out 'new' (nothing locks between this read and the
 * write); the soft fold then hides the later one when the author is the same.
 */
import { Effect } from 'effect';
import { decodeExchangeString } from './decode';
import { fingerprintPrint, type PrintFingerprint } from './identity';
import { blockedBy, blockHashes, JOIN_MIN_SIZE, PAGE_MIN_SIZE } from './identity-db';
import type { SourceRecord } from './source-record';

export interface AdmitLimits {
	/** UTF-8 bytes of the exchange string. */
	readonly maxStringBytes: number;
	readonly maxEntitiesAndTiles: number;
}

/**
 * The Worker path's caps (upload, edit, add by URL): memory, not CPU, is the limit (128 MB per isolate;
 * a 512 KB string grows the heap ≈ 30 MB through decode, analysis and fingerprint). ≈ 97% of factorioprints.
 */
export const WORKER_LIMITS: AdmitLimits = { maxStringBytes: 512 * 1024, maxEntitiesAndTiles: 150_000 };

export { JOIN_MIN_SIZE };

export interface AdmitOptions {
	/** Caps for the Worker; none in Bun. */
	readonly limits?: AdmitLimits;
	/** decode's zip-bomb cap (decode.ts default when omitted). */
	readonly maxInflatedBytes?: number;
}

export type Suggestion =
	/** The whole print, exactly, but under JOIN_MIN_SIZE: likely a standard design built alike. */
	| { readonly kind: 'small-exact'; readonly printId: string; readonly size: number }
	/** The whole print's layout (names, positions, recipes, wires): may differ only in settings. */
	| { readonly kind: 'layout'; readonly printId: string }
	/** Pages (from PAGE_MIN_SIZE up) found exactly in another print: `shared` of this one's `ofThis`, of that one's `ofThat`. */
	| { readonly kind: 'pages'; readonly printId: string; readonly shared: number; readonly ofThis: number; readonly ofThat: number };

export interface Admitted {
	/** The decoded exchange string, so the caller doesn't decode twice. */
	readonly decoded: unknown;
	readonly fingerprint: PrintFingerprint;
	/** Entities + tiles over every page. */
	readonly size: number;
	/** Live prints only, never the matched print itself, never blocks. */
	readonly suggestions: readonly Suggestion[];
}

/** What `ingestRecord` takes: an 'existing' answer, or a 'new' one with the print id the caller chose. */
export type Admission =
	| Extract<AdmitResult, { status: 'existing' }>
	| (Extract<AdmitResult, { status: 'new' }> & { readonly printId: string });

export type AdmitResult =
	| { readonly status: 'blocked'; readonly by: 'source' | 'sha256' }
	| { readonly status: 'too-big'; readonly by: 'string' | 'entities'; readonly size: number; readonly limit: number }
	| { readonly status: 'undecodable'; readonly reason: string }
	| { readonly status: 'existing'; readonly printId: string; readonly via: 'source' | 'exact'; readonly admitted: Admitted }
	| { readonly status: 'new'; readonly copyOf: string | null; readonly admitted: Admitted };

const MAX_SUGGESTIONS = 10;

/** Entities + tiles of every blueprint in a payload, without fingerprinting (for the cap). */
const countEntitiesAndTiles = (obj: unknown, depth = 0): number => {
	if (depth > 32 || !obj || typeof obj !== 'object') return 0;
	const o = obj as Record<string, unknown>;
	const bp = o.blueprint as Record<string, unknown> | undefined;
	if (bp && typeof bp === 'object') {
		return (Array.isArray(bp.entities) ? bp.entities.length : 0) + (Array.isArray(bp.tiles) ? bp.tiles.length : 0);
	}
	const book = o.blueprint_book as Record<string, unknown> | undefined;
	if (!book || typeof book !== 'object' || !Array.isArray(book.blueprints)) return 0;
	let n = 0;
	for (const child of book.blueprints) n += countEntitiesAndTiles(child, depth + 1);
	return n;
};

interface Candidate {
	print_id: string;
	size: number;
	/** Earliest live source's upload time (else first seen); null when no live source. */
	posted: number | null;
	/** Live sources other than factorioprints. */
	others: number;
}

const byPosted = (a: Candidate, b: Candidate) =>
	(a.posted ?? Number.MAX_SAFE_INTEGER) - (b.posted ?? Number.MAX_SAFE_INTEGER) || (a.print_id < b.print_id ? -1 : 1);

/** Live prints (a `prints` row) whose current content (as fold.ts groups) has `sha256` as `kind`, with when each was first posted. */
const CANDIDATES = (kind: string) => `
	SELECT f.print_id AS print_id, MAX(f.size) AS size,
		(SELECT MIN(COALESCE(s.uploaded_at, s.first_seen)) FROM print_sources s WHERE s.print_id = f.print_id AND s.gone_at IS NULL) AS posted,
		(SELECT COUNT(*) FROM print_sources s WHERE s.print_id = f.print_id AND s.gone_at IS NULL AND s.site != 'factorioprints') AS others
	FROM print_fingerprints f JOIN prints p ON p.id = f.print_id
	WHERE f.kind = '${kind}' AND f.sha256 = ? AND f.current = 1
	GROUP BY f.print_id`;

/** Every page hash (from PAGE_MIN_SIZE up) other live prints share with this one: per print, how many, of its own how many. */
const PAGE_OVERLAP = `
	SELECT f.print_id AS print_id, COUNT(DISTINCT f.sha256) AS shared,
		(SELECT COUNT(DISTINCT g.sha256) FROM print_fingerprints g
			WHERE g.print_id = f.print_id AND g.kind = 'page' AND g.current = 1 AND g.size >= ?2) AS pages
	FROM print_fingerprints f JOIN prints p ON p.id = f.print_id
	WHERE f.kind = 'page' AND f.current = 1 AND f.sha256 IN (SELECT value FROM json_each(?1))
	GROUP BY f.print_id ORDER BY shared DESC, f.print_id LIMIT ?3`;

const sourceRow = (db: D1Database, r: SourceRecord) =>
	db
		.prepare(`SELECT s.print_id AS print_id FROM print_sources s JOIN prints p ON p.id = s.print_id WHERE s.site = ? AND s.site_id = ?`)
		.bind(r.site, r.siteId);

/** Decide what a record is: see the header. */
export async function admitRecord(db: D1Database, record: SourceRecord, options: AdmitOptions = {}): Promise<AdmitResult> {
	if ((await blockedBy(db, record, []))?.by === 'source') return { status: 'blocked', by: 'source' };
	const { limits } = options;
	if (limits) {
		const bytes = new TextEncoder().encode(record.blueprintString).length;
		if (bytes > limits.maxStringBytes) return { status: 'too-big', by: 'string', size: bytes, limit: limits.maxStringBytes };
	}
	const decoded = await Effect.runPromise(
		decodeExchangeString(record.blueprintString, { maxInflatedBytes: options.maxInflatedBytes }).pipe(Effect.result)
	);
	if (decoded._tag === 'Failure') return { status: 'undecodable', reason: decoded.failure.reason };
	const payload = decoded.success;
	if (limits) {
		const size = countEntitiesAndTiles(payload);
		if (size > limits.maxEntitiesAndTiles) return { status: 'too-big', by: 'entities', size, limit: limits.maxEntitiesAndTiles };
	}
	const fingerprint = await fingerprintPrint(payload);
	return judge(db, record, payload, fingerprint);
}

/** Steps 3–6 for a record already decoded and fingerprinted. */
export async function judge(db: D1Database, record: SourceRecord, decoded: unknown, fingerprint: PrintFingerprint): Promise<AdmitResult> {
	const blocked = await blockedBy(db, record, blockHashes(fingerprint));
	if (blocked) return { status: 'blocked', by: blocked.by };
	const whole = fingerprint.whole;
	const pageHashes = [...new Set(fingerprint.pages.filter((p) => p.entities + p.tiles >= PAGE_MIN_SIZE).map((p) => p.exact))];
	const none = db.prepare('SELECT NULL AS print_id WHERE 0');
	const [own, exact, layout, pages] = await db.batch<Record<string, unknown>>([
		sourceRow(db, record),
		whole ? db.prepare(CANDIDATES('print')).bind(whole.exact) : none,
		whole ? db.prepare(CANDIDATES('print_layout')).bind(whole.layout) : none,
		pageHashes.length ? db.prepare(PAGE_OVERLAP).bind(JSON.stringify(pageHashes), PAGE_MIN_SIZE, MAX_SUGGESTIONS + 2) : none
	]);
	const ownId = (own.results[0]?.print_id as string | undefined) ?? null;
	const exactMatches = (exact.results as unknown as Candidate[]).filter((c) => c.print_id !== ownId).sort(byPosted);
	const joinable = exactMatches.filter((c) => c.size >= JOIN_MIN_SIZE);

	let printId: string | null = ownId;
	let via: 'source' | 'exact' = 'source';
	let copyOf: string | null = null;
	if (!printId && joinable.length) {
		const posted = record.uploadedAt ?? Number.MAX_SAFE_INTEGER;
		if (record.site === 'factorioprints') {
			const brought = joinable.filter((c) => c.others > 0);
			if (brought.length) [printId, via] = [brought[0].print_id, 'exact'];
			else copyOf = joinable.find((c) => (c.posted ?? Number.MAX_SAFE_INTEGER) <= posted)?.print_id ?? null;
		} else [printId, via] = [joinable[0].print_id, 'exact'];
	}

	const shown = new Set([printId, copyOf]);
	const suggestions: Suggestion[] = [];
	for (const c of exactMatches) {
		if (c.size < JOIN_MIN_SIZE && !shown.has(c.print_id)) {
			suggestions.push({ kind: 'small-exact', printId: c.print_id, size: c.size });
			shown.add(c.print_id);
		}
	}
	for (const c of joinable) shown.add(c.print_id);
	for (const c of (layout.results as unknown as Candidate[]).sort(byPosted)) {
		if (!shown.has(c.print_id) && c.print_id !== ownId) {
			suggestions.push({ kind: 'layout', printId: c.print_id });
			shown.add(c.print_id);
		}
	}
	for (const r of pages.results as unknown as { print_id: string; shared: number; pages: number }[]) {
		if (!shown.has(r.print_id) && r.print_id !== ownId) {
			suggestions.push({ kind: 'pages', printId: r.print_id, shared: r.shared, ofThis: pageHashes.length, ofThat: r.pages });
			shown.add(r.print_id);
		}
	}
	const admitted: Admitted = {
		decoded,
		fingerprint,
		size: whole?.size ?? 0,
		suggestions: suggestions.slice(0, MAX_SUGGESTIONS)
	};
	return printId ? { status: 'existing', printId, via, admitted } : { status: 'new', copyOf, admitted };
}
