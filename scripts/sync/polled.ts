/**
 * Polled sites as sources of the one-click update: a site with a public list of its prints, most recently
 * changed first (factoriocodex.com, sync/codex.ts), or all at once (fprints.xyz's sitemap, sync/fprints.ts).
 * Generic: a site is a `PolledSite` (one list page, one record), and this module does the rest.
 *
 * Contract:
 * - **Fetch step** (`polledSource(...)`, a SourceAdapter run in the update's own process):
 *   - plan: list pages until past the cursor (the newest `updatedAt` this machine has listed), usually one
 *     request. A record whose revision (`rev`, e.g. its `updated_at`) differs from the inbox's is work.
 *     The site's `total` is then checked against the prints this machine knows plus the new ones: when it
 *     differs (a print deleted, made private, or shown again), or the last full listing is older than
 *     FULL_EVERY_MS, or there is no cursor yet, every page is listed (≈ 5 at 100 a page), and prints the
 *     listing no longer has are deletions to confirm. Held back (`blocked`, like the mirror) when the list
 *     is empty while this machine knows prints, or by the one hold-back rule (#lib/sync.js `holdBack`): new
 *     and missing prints more than `maxChange` of the known ones and at least 25, or a first import; unless
 *     that plan's `to.id` was accepted. Changed prints never count.
 *   - apply: read every new or changed record (oldest change first) and each deletion to confirm; there is no
 *     read cap. Reads a stop or a failure leaves stay `pending` for the next update. A record is written to the inbox
 *     (`<RECORDS_DIR>/.polled/<site>/<siteId>.json`, a SourceRecord, store.ts's format) only when its text
 *     changed; one answering "gone" (404, no longer public) leaves the inbox and is listed in `gone`.
 *   - Every request goes through one PoliteHttp: a User-Agent naming the project, at most one request per
 *     MIN_INTERVAL_MS, a few retries on 429/5xx honouring Retry-After.
 *   - State: `<inbox>/<site>/.poll.json` (PollState): cursor, last full listing, known records and
 *     their revisions, pending reads, gone ids. Machine-local, like the record store.
 * - **Ingest step** (`bun run polled --stage S --site X`, scripts/polled.ts): every inbox record whose
 *   revision the stage hasn't had goes through the one gate (admitRecord, then ingestRecord), and every gone
 *   id the stage still has is a source gone (sourceGone). What each stage was given is in
 *   `<inbox>/<site>/.admitted.<stage>.json` (AdmittedLedger).
 * - **Record store**: the store proper (`<RECORDS_DIR>/<site>/`, what renders read) holds only the prints
 *   that are their own print on the stage, filled from the stage by `bun run records` (records/polled.ts),
 *   so a record that joined another print is never drawn under its own id.
 *
 * Node only.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detail, GROUP, holdBack, holdLimit, ROW, type DetailGroup, type SourcePlan } from '#lib/sync.js';
import { sha256Hex } from '#lib/server/hash.js';
import type { SourceRecord } from '#lib/server/pipeline/source-record.js';
import { dropRecord, putRecord, type StoreSite } from '../records/store';
import type { PlanOptions, SourceAdapter } from './mirror';
import { progress } from './progress';

/** One print as a site lists it: its id, a revision that changes whenever the record does, and that change's time (unix ms). */
export interface ListedPrint {
	siteId: string;
	rev: string;
	updatedAt: number;
}

export interface ListPage {
	items: ListedPrint[];
	/** Prints the site lists in all, and pages at the site's page size. */
	total: number;
	totalPages: number;
}

/** A record read: the record, or gone (404, no longer public) with why. */
export type Fetched = { record: SourceRecord } | { gone: string };

export interface PolledSite {
	site: StoreSite;
	/**
	 * Bump when the record builder makes something else from the same answer: the next fetch lists every page
	 * and reads every print again (its revisions should carry it too, so each one differs).
	 */
	version?: number;
	/**
	 * One page lists every print the site has (a sitemap): every listing is a full one, so deletions are
	 * noticed at once, and the cursor only orders the reads.
	 */
	listsAll?: boolean;
	/** Page `page` (from 1) of the site's public prints, most recently changed first. */
	listPage(page: number, http: PoliteHttp, signal?: AbortSignal): Promise<ListPage>;
	/** One record, read without counting a view. */
	fetchRecord(siteId: string, http: PoliteHttp, signal?: AbortSignal): Promise<Fetched>;
}

// --- requests

/** The User-Agent of every request to another site. */
export const USER_AGENT = 'factorio-atlas/1.0 (Blueprint Atlas print importer; +https://github.com/jsmenzies/factorio-atlas)';
/** At most one request a second, with room. */
export const MIN_INTERVAL_MS = 1100;

export interface HttpOptions {
	userAgent?: string;
	minIntervalMs?: number;
	timeoutMs?: number;
	/** Tries for one request on 429, 5xx and network errors. */
	tries?: number;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How much of a failed answer's body `goneIf` sees: an error message, never a whole page. */
const ERROR_BODY_BYTES = 4096;

/** The first `max` bytes of a body as text; the rest is never read. */
const headText = async (res: Response, max: number) => {
	const reader = res.body?.getReader();
	if (!reader) return '';
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (size < max) {
			const part = await reader.read();
			if (part.done) break;
			chunks.push(part.value);
			size += part.value.length;
		}
	} catch {
		// A body cut short: what came is enough.
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	const all = new Uint8Array(size);
	let at = 0;
	for (const c of chunks) {
		all.set(c, at);
		at += c.length;
	}
	return new TextDecoder().decode(all.subarray(0, max));
};

/** How a GET's body is read, and which failures mean the record isn't there (a site that answers 500 for an unknown id). */
export interface GetOptions {
	/** The body as text (a sitemap), not JSON. */
	text?: boolean;
	/** A failed answer (status, its body's text) that says the record doesn't exist: passed back as `{ status, body: null }`, not retried. */
	goneIf?: (status: number, text: string) => boolean;
}

/** Paced, retried GETs of JSON (or text). Counts its requests (`lists`, `reads`). */
export class PoliteHttp {
	lists = 0;
	reads = 0;
	private last = 0;
	constructor(private readonly o: HttpOptions = {}) {}

	/**
	 * The body (JSON, or text with `text`), or `{ status }` alone for 404, 410 and what `goneIf` says is gone.
	 * Throws on other failures, after retrying those worth it.
	 */
	async get(url: string, kind: 'list' | 'read', signal?: AbortSignal, g: GetOptions = {}): Promise<{ status: number; body: unknown }> {
		const sleep = this.o.sleep ?? wait;
		const tries = this.o.tries ?? 3;
		for (let attempt = 1; ; attempt++) {
			signal?.throwIfAborted();
			const gap = this.last + (this.o.minIntervalMs ?? MIN_INTERVAL_MS) - Date.now();
			if (gap > 0) await sleep(gap);
			this.last = Date.now();
			if (kind === 'list') this.lists++;
			else this.reads++;
			let res: Response;
			try {
				res = await (this.o.fetch ?? fetch)(url, {
					headers: {
						'user-agent': this.o.userAgent ?? USER_AGENT,
						accept: g.text ? 'application/xml, text/xml;q=0.9, */*;q=0.1' : 'application/json'
					},
					signal: AbortSignal.any([AbortSignal.timeout(this.o.timeoutMs ?? 60_000), ...(signal ? [signal] : [])])
				});
			} catch (e) {
				if (signal?.aborted || attempt >= tries) throw e;
				await sleep(5000 * attempt);
				continue;
			}
			if (res.status === 404 || res.status === 410) {
				await res.body?.cancel();
				return { status: res.status, body: null };
			}
			if (res.ok) return { status: res.status, body: g.text ? await res.text() : await res.json() };
			if (g.goneIf) {
				const text = await headText(res, ERROR_BODY_BYTES);
				if (g.goneIf(res.status, text)) return { status: res.status, body: null };
			} else await res.body?.cancel();
			if ((res.status === 429 || res.status >= 500) && attempt < tries) {
				const after = Number(res.headers.get('retry-after'));
				await sleep(Math.min(120_000, Number.isFinite(after) && after > 0 ? after * 1000 : 5000 * attempt));
				continue;
			}
			throw new Error(`${url}: HTTP ${res.status}`);
		}
	}
}

// --- record helpers, for each site's record builder

/** Unix ms of an ISO time, or null. */
export const time = (s: string | null | undefined) => {
	const t = s ? Date.parse(s) : NaN;
	return Number.isFinite(t) ? t : null;
};

/** "2.0.73.1" or "Version 2.0" → the factorioprints-style tag "/version/2,0/" (the version facet reads those). */
export const versionTag = (v: string | null | undefined) => {
	const m = /^(?:Version )?(\d+)\.(\d+)/.exec(v?.trim() ?? '');
	return m ? `/version/${Number(m[1])},${Number(m[2])}/` : null;
};

/** Links in a description (without the sentence's own trailing punctuation): what may name the same print elsewhere. */
export const linksIn = (text: string | null) =>
	[...new Set((text?.match(/https?:\/\/[^\s)\]<>"']+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, '')))].slice(0, 20);

// --- state

/** How often every page is listed anyway, to notice deletions the totals hide. */
export const FULL_EVERY_MS = 7 * 24 * 3600_000;

export interface PollState {
	v: 1;
	/** The newest `updatedAt` listed (unix ms); 0: never listed. */
	cursor: number;
	/** The last full listing (unix ms). */
	fullAt: number;
	/** The site's total at the last fetch. */
	total: number;
	/** The site's record version (PolledSite.version) the inbox was read with. */
	version?: number;
	/** Every record in the inbox: its revision, when this machine first had it, when it was read. */
	records: Record<string, { rev: string; firstSeen: number; fetchedAt: number }>;
	/** Listed but not read yet (a stop, a failed read): id → the revision listed. */
	pending: Record<string, string>;
	/** Gone from the site (404, no longer public): id → when found. A print that comes back leaves it. */
	gone: Record<string, number>;
}

export const emptyState = (): PollState => ({ v: 1, cursor: 0, fullAt: 0, total: 0, records: {}, pending: {}, gone: {} });

/** The inbox of polled sites' records: beside the record store's sites, hidden from its readers. */
export const inboxDir = (recordsDir: string) => join(recordsDir, '.polled');

const stateFile = (inbox: string, site: string) => join(inbox, site, '.poll.json');

let tmpCount = 0;
export const writeJsonAtomic = async (file: string, value: unknown) => {
	const tmp = `${file}.${process.pid}-${++tmpCount}.tmp`;
	await writeFile(tmp, JSON.stringify(value));
	await rename(tmp, file);
};

export async function readState(inbox: string, site: string): Promise<PollState> {
	try {
		const s = JSON.parse(await readFile(stateFile(inbox, site), 'utf8')) as PollState;
		if (s.v === 1 && s.records && s.pending && s.gone) return s;
	} catch {
		// Missing or unreadable: a first import (every record read again, written only when its text changed).
	}
	return emptyState();
}

export async function writeState(inbox: string, site: string, s: PollState) {
	await mkdir(join(inbox, site), { recursive: true });
	await writeJsonAtomic(stateFile(inbox, site), s);
}

/** What one stage was given of a site's inbox: id → the revision admitted, or 'gone' once its source-gone ran. */
export interface AdmittedLedger {
	v: 1;
	records: Record<string, string>;
}

export const ledgerFile = (inbox: string, site: string, stage: string) => join(inbox, site, `.admitted.${stage}.json`);

export async function readLedger(inbox: string, site: string, stage: string): Promise<AdmittedLedger> {
	try {
		const l = JSON.parse(await readFile(ledgerFile(inbox, site, stage), 'utf8')) as AdmittedLedger;
		if (l.v === 1 && l.records) return l;
	} catch {
		// Missing: nothing admitted yet.
	}
	return { v: 1, records: {} };
}

export async function writeLedger(inbox: string, site: string, stage: string, l: AdmittedLedger) {
	await mkdir(join(inbox, site), { recursive: true });
	await writeJsonAtomic(ledgerFile(inbox, site, stage), l);
}

/**
 * What a stage still needs: inbox records at a revision it wasn't given, or whose print it lost (`lost`:
 * identity-db.ts `lostSources`, a hand-over that had to purge), and gone ids it still has.
 */
export const admissionWork = (state: PollState, ledger: AdmittedLedger, force = false, lost: Iterable<string> = []) => {
	const again = new Set(lost);
	return {
		records: Object.entries(state.records)
			.filter(([id, r]) => force || ledger.records[id] !== r.rev || again.has(id))
			.map(([id]) => id)
			.sort((a, b) => state.records[a].firstSeen - state.records[b].firstSeen || a.localeCompare(b, 'en', { numeric: true })),
		gone: Object.keys(state.gone)
			.filter((id) => ledger.records[id] !== undefined && ledger.records[id] !== 'gone')
			.sort()
	};
};

/**
 * What a retried admission's 'already' (`updated` or `unchanged`) really was: a try that threw may have written
 * the print first, so for a source the stage didn't have before the first try it is that try's work: 'new' when
 * the print is the record's own, else 'joined'. null when the source was known before (a real 'already').
 */
export const retriedAs = (knownBefore: boolean, printId: string, ownPrintId: string): 'new' | 'joined' | null =>
	knownBefore ? null : printId === ownPrintId ? 'new' : 'joined';

// --- plan

/**
 * The most prints one fetch believes gone at read time: the hold-back rule's limit (#lib/sync.js `holdLimit`). The
 * plan counts new and missing prints against it; the reads count only those they find gone, as a new record
 * read can't take anything off the site, while a listing glitch could make many look missing.
 */
export const goneLimit = (maxChange: number, known: number) => Math.floor(holdLimit(maxChange, known));

/** What a fetch would do: the records to read and the deletions to confirm, with the listing they came from. */
export interface PollWork {
	/** id → the revision listed, oldest change first (pending ones the listing no longer shows first of all). */
	read: { siteId: string; rev: string; updatedAt: number }[];
	/** Known ids the full listing lacks: read each to confirm (404 or private = gone). */
	missing: string[];
	/** This plan was accepted (sync_meta 'accept'): its missing prints may all be found gone. */
	accepted: boolean;
	/** Pending reads a full listing no longer shows: dropped. */
	dropPending: string[];
	/** Every page was listed. */
	full: boolean;
	/** The newest change listed. */
	newest: number;
	total: number;
	added: number;
	changed: number;
}

const digest = async (text: string) => (await sha256Hex(text)).slice(0, 12);

const day = (ms: number) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : 'never');

/** Lists the site until past the cursor (or every page when needed) and says what a fetch would read. */
export async function planPoll(
	site: PolledSite,
	state: PollState,
	http: PoliteHttp,
	o: { maxChange: number; accept?: string; now?: number; signal?: AbortSignal; full?: boolean }
): Promise<{ plan: SourcePlan; work: PollWork }> {
	const now = o.now ?? Date.now();
	const known = new Set([...Object.keys(state.records), ...Object.keys(state.pending)]);
	const listed = new Map<string, ListedPrint>();
	const first = await site.listPage(1, http, o.signal);
	for (const it of first.items) listed.set(it.siteId, it);
	let page = 1;
	let full = o.full || site.listsAll === true || state.cursor === 0 || now - state.fullAt > FULL_EVERY_MS;
	const more = () => page < first.totalPages;
	const listNext = async () => {
		page++;
		for (const it of (await site.listPage(page, http, o.signal)).items) if (!listed.has(it.siteId)) listed.set(it.siteId, it);
	};
	const oldest = () => Math.min(...[...listed.values()].map((i) => i.updatedAt));
	while (more() && !full && listed.size && oldest() > state.cursor) await listNext();
	if (!full) {
		// Every print changed since the cursor is listed now: the total says whether any went (or came back).
		const unseen = [...listed.keys()].filter((id) => !known.has(id)).length;
		if (first.total !== known.size + unseen) full = true;
	}
	// A new record version (the site's builder makes something else now): every page, every print read again.
	if ((state.version ?? 0) !== (site.version ?? 0)) full = true;
	if (full) while (more()) await listNext();

	const read = new Map<string, { siteId: string; rev: string; updatedAt: number }>();
	for (const it of [...listed.values()].sort((a, b) => a.updatedAt - b.updatedAt)) {
		const have = state.records[it.siteId];
		if (have?.rev === it.rev && !(it.siteId in state.pending)) continue;
		read.set(it.siteId, it);
	}
	// Pending reads the listing didn't show (listed only until the cursor): read them too, first.
	for (const [siteId, rev] of Object.entries(state.pending))
		if (!read.has(siteId) && (!full || listed.has(siteId))) read.set(siteId, { siteId, rev, updatedAt: 0 });
	// New: never read into the inbox (a pending read that never succeeded is new too, listed or not); changed: read before.
	const changed = [...read.keys()].filter((id) => id in state.records).length;
	const added = read.size - changed;
	const missing = full ? Object.keys(state.records).filter((id) => !listed.has(id)) : [];
	const work: PollWork = {
		read: [...read.values()].sort((a, b) => a.updatedAt - b.updatedAt),
		missing,
		accepted: false,
		dropPending: full ? Object.keys(state.pending).filter((id) => !listed.has(id)) : [],
		full,
		newest: Math.max(state.cursor, ...[...listed.values()].map((i) => i.updatedAt)),
		total: first.total,
		added,
		changed
	};

	const knownCount = Object.keys(state.records).length;
	const from = { id: `${knownCount}@${state.cursor}`, date: state.cursor };
	const moved = work.read.length > 0 || missing.length > 0;
	const to = moved
		? {
				id: `${first.total}@${work.newest}:${await digest([...work.read.map((r) => `${r.siteId}:${r.rev}`), ...missing.map((m) => `-${m}`)].join('\n'))}`,
				date: work.newest
			}
		: from;
	work.accepted = o.accept === to.id;
	let blocked: string | null = null;
	if (first.total === 0 && knownCount > 0)
		blocked = `the site lists no prints (this machine has ${knownCount.toLocaleString('en-US')}): check the site before fetching`;
	else
		blocked = holdBack({
			// Reads left pending (a stopped fetch, a failed read) passed an earlier plan: only prints new since count.
			added: [...read.keys()].filter((id) => !(id in state.records) && !(id in state.pending)).length,
			removed: missing.length,
			known: knownCount,
			maxChange: o.maxChange,
			accepted: work.accepted,
			what: 'the site'
		});
	const pending = Object.keys(state.pending).length;
	const plan: SourcePlan = {
		site: site.site,
		polled: true,
		behind: work.read.length,
		from,
		to,
		prints: first.total,
		added,
		edited: changed,
		favourites: 0,
		deleted: missing,
		modern: 0,
		blocked,
		left: pending,
		position:
			`${knownCount.toLocaleString('en-US')} prints on this machine, ${first.total.toLocaleString('en-US')} on the site · ` +
			`newest change ${day(state.cursor)} · full listing ${day(state.fullAt)}` +
			(pending ? ` · ${pending.toLocaleString('en-US')} left from the last update` : ''),
		stateText: moved
			? [
					...(added ? [`${added.toLocaleString('en-US')} new`] : []),
					...(changed ? [`${changed.toLocaleString('en-US')} changed`] : []),
					...(missing.length ? [`${missing.length.toLocaleString('en-US')} gone?`] : [])
				].join(', ')
			: undefined
	};
	return { plan, work };
}

// --- apply

export interface ApplyCounts {
	/** Requests made: list pages (plan) and record reads. */
	lists: number;
	reads: number;
	/** Records new to the inbox, changed (`rewritten` of them with new text), gone (404, private). */
	new: number;
	changed: number;
	rewritten: number;
	gone: number;
	/** Listed as missing but still there (a listing glitch). */
	stillThere: number;
	/** Missing and answering gone, past the most one fetch believes (goneLimit): kept, checked again. */
	goneHeld: number;
	/** Reads that failed: pending, tried again next update. */
	failed: number;
	/** Not read: the fetch stopped; pending. */
	left: number;
}

/** Reads all the work a plan found into the inbox (until a stop); returns the new state's counts. */
export async function applyPoll(
	site: PolledSite,
	inbox: string,
	state: PollState,
	work: PollWork,
	http: PoliteHttp,
	o: {
		/** At most this share of the known prints (and 25) is marked gone in one fetch (the plan's guard, again on the reads). */
		maxChange: number;
		stopping?: () => boolean;
		signal?: AbortSignal;
		log?: (line: string) => void;
		now?: () => number;
	}
): Promise<ApplyCounts> {
	const now = o.now ?? Date.now;
	const log = o.log ?? (() => undefined);
	const stopping = () => (o.stopping?.() ?? false) || (o.signal?.aborted ?? false);
	const c: ApplyCounts = {
		lists: http.lists,
		reads: 0,
		new: 0,
		changed: 0,
		rewritten: 0,
		gone: 0,
		stillThere: 0,
		goneHeld: 0,
		failed: 0,
		left: 0
	};
	const maxGone = work.accepted ? Infinity : goneLimit(o.maxChange, Object.keys(state.records).length);
	const readsBefore = http.reads;
	let sinceSave = 0;
	const save = () => writeState(inbox, site.site, state);
	const markGone = async (siteId: string, why: string) => {
		const had = siteId in state.records;
		delete state.records[siteId];
		delete state.pending[siteId];
		await dropRecord(inbox, site.site, siteId);
		if (had) {
			state.gone[siteId] = now();
			c.gone++;
		}
		log(`${site.site}/${siteId}: gone (${why})`);
		progress({ t: 'record', site: site.site, outcome: 'gone' });
	};
	/**
	 * One read. `rev` is the revision a listing showed (a print it lists as public): then a "gone" answer is a
	 * failed read, kept pending. Only a print missing from a full listing (`rev` null) can be found gone, and
	 * at most `maxGone` in one fetch.
	 */
	const readOne = async (siteId: string, rev: string | null) => {
		let got: Fetched;
		try {
			got = await site.fetchRecord(siteId, http, o.signal);
			if ('record' in got && (got.record.site !== site.site || got.record.siteId !== siteId))
				throw new Error(`the record says it is ${got.record.site}/${got.record.siteId}`);
		} catch (e) {
			if (o.signal?.aborted) throw e;
			c.failed++;
			if (rev !== null) state.pending[siteId] = rev;
			log(`${site.site}/${siteId}: ✗ ${e instanceof Error ? e.message : e}`);
			progress({ t: 'record', site: site.site, outcome: 'failed' });
			return 'failed' as const;
		}
		if ('gone' in got) {
			if (rev !== null) {
				// The list says it is there: the detail endpoint answering otherwise is the site's problem, not a deletion.
				c.failed++;
				state.pending[siteId] = rev;
				log(`${site.site}/${siteId}: ✗ listed, but its record answered ${got.gone}: tried again next update`);
				progress({ t: 'record', site: site.site, outcome: 'failed' });
				return 'failed' as const;
			}
			if (c.gone >= maxGone) {
				c.goneHeld++;
				log(`${site.site}/${siteId}: ✗ ${got.gone}, but ${c.gone} already gone in this fetch (the most it believes): kept`);
				progress({ t: 'record', site: site.site, outcome: 'failed' });
				return 'failed' as const;
			}
			await markGone(siteId, got.gone);
			return 'gone' as const;
		}
		const had = state.records[siteId];
		const wrote = await putRecord(inbox, got.record);
		const t = now();
		state.records[siteId] = { rev: rev ?? had?.rev ?? String(got.record.updatedAt ?? t), firstSeen: had?.firstSeen ?? t, fetchedAt: t };
		delete state.pending[siteId];
		delete state.gone[siteId];
		if (had) {
			c.changed++;
			if (wrote) c.rewritten++;
		} else c.new++;
		log(`${site.site}/${siteId}: ${had ? (wrote ? 'changed' : 'same text') : 'new'}`);
		progress({ t: 'record', site: site.site, outcome: had ? (wrote ? 'changed' : 'same') : 'new' });
		return 'ok' as const;
	};

	// Pending reads stay in the state until each is read, so a fetch cut short loses none; a full listing
	// drops those the site no longer lists (never read: nothing else to undo).
	for (const id of work.dropPending) delete state.pending[id];
	const queue = [...work.read];
	while (queue.length && !stopping()) {
		const next = queue.shift()!;
		await readOne(next.siteId, next.rev);
		if (++sinceSave >= 25) {
			sinceSave = 0;
			await save();
		}
	}
	for (const left of queue) state.pending[left.siteId] = left.rev;
	c.left = queue.length;
	// Deletions: each confirmed by a read of its own (a list that merely missed it keeps it).
	const missing = [...work.missing];
	while (missing.length && !stopping()) {
		const id = missing.shift()!;
		if ((await readOne(id, null)) === 'ok') c.stillThere++;
	}
	c.left += missing.length;
	state.cursor = work.newest;
	if (work.full && !missing.length && !c.goneHeld) state.fullAt = now();
	state.total = work.total;
	// Every print was listed, so each one at the old version is read or pending now.
	if (work.full) state.version = site.version ?? 0;
	await save();
	c.reads = http.reads - readsBefore;
	return c;
}

// --- the update's source

export interface PolledSourceOptions {
	/** The record store (RECORDS_DIR); the inbox is its `.polled` folder. */
	recordsDir: string;
	settings: () => { on: boolean };
	log?: (line: string) => void;
	stopping?: () => boolean;
	http?: PoliteHttp;
}

/** A polled site as one of the update's sources: plan lists, apply reads. Its counts go to the update's `sources` JSON. */
export function polledSource(site: PolledSite, o: PolledSourceOptions): SourceAdapter & { lastApply?: string } {
	const inbox = inboxDir(o.recordsDir);
	const http = o.http ?? new PoliteHttp();
	let planned: { state: PollState; work: PollWork; toId: string; maxChange: number } | null = null;
	const adapter: SourceAdapter & { lastApply?: string } = {
		site: site.site,
		polled: true,
		plan: async (p: PlanOptions): Promise<SourcePlan> => {
			if (!o.settings().on) {
				const none = { id: 'off', date: 0 };
				return {
					site: site.site,
					polled: true,
					off: true,
					from: none,
					to: none,
					prints: 0,
					added: 0,
					edited: 0,
					favourites: 0,
					deleted: [],
					modern: 0,
					blocked: null,
					position: 'off in the settings: not checked'
				};
			}
			const state = await readState(inbox, site.site);
			const { plan, work } = await planPoll(site, state, http, { maxChange: p.maxChange, accept: p.accept, signal: p.signal });
			planned = { state, work, toId: plan.to.id, maxChange: p.maxChange };
			return plan;
		},
		apply: async (plan, signal) => {
			if (!planned || planned.toId !== plan.to.id) throw new Error(`${site.site}: apply without its plan`);
			const { state, work, maxChange } = planned;
			planned = null;
			const c = await applyPoll(site, inbox, state, work, http, {
				maxChange,
				stopping: o.stopping,
				signal,
				log: o.log
			});
			const pending = Object.keys(state.pending).length;
			adapter.lastApply =
				`${Object.keys(state.records).length.toLocaleString('en-US')} prints on this machine, ${state.total.toLocaleString('en-US')} on the site` +
				(pending ? ` · ${pending.toLocaleString('en-US')} left for the next update` : '');
			return {
				id: pending ? `${plan.to.id}+${pending}` : plan.to.id,
				date: state.cursor,
				counts: {
					'list pages': c.lists,
					'records read': c.reads,
					new: c.new,
					changed: c.changed,
					'gone from the site': c.gone,
					'still listed after all': c.stillThere,
					'gone, held (too many at once)': c.goneHeld,
					failed: c.failed,
					left: pending
				}
			};
		}
	};
	return adapter;
}

// --- the Overview's figures

/** The fetch step's rows for a polled site: its plan, and how the reads came out (`counts` from apply). */
export const polledFetchDetails = (p: SourcePlan, counts: Record<string, number> | undefined): DetailGroup => ({
	title: p.site,
	rows: p.off
		? [{ label: 'off in the settings', value: 'not checked' }]
		: [
				...detail('held back', p.blocked, { tone: 'warn' }),
				...detail(ROW.printsOnSite, p.prints, { always: true }),
				...detail('new to read', p.added, { always: !p.blocked }),
				...detail('changed to read', p.edited),
				...detail('missing from the list', p.deleted.length, { tone: 'warn' }),
				...(counts
					? [
							...detail('list pages read', counts['list pages']),
							...detail('records read', counts['records read'], { always: true }),
							...detail('new', counts.new),
							...detail('changed', counts.changed),
							...detail('gone from the site', counts['gone from the site'], { tone: 'warn' }),
							...detail('still listed after all', counts['still listed after all']),
							...detail('gone, held (too many at once)', counts['gone, held (too many at once)'], { tone: 'warn' }),
							...detail('failed, tried again next update', counts.failed ?? 0, { always: true, tone: 'bad' }),
							...detail('left for the next update', counts.left, { tone: 'warn' })
						]
					: [])
			]
});

/** The admission's result as `polled --json` gives it (scripts/polled.ts PolledAdmitResult), the fields shown. */
interface AdmitFigures {
	site: string;
	waiting: number;
	counts: Record<string, number>;
	gone: { purged: number; kept: number; failed: number; waiting: number; edgeNotPurged: number };
	suggestedNew: number;
}

/** The ingest step's rows for a polled site's admission. */
export const polledIngestDetails = (r: AdmitFigures): DetailGroup[] => [
	{
		title: GROUP.gate(r.site),
		rows: [
			...detail(ROW.toAdmit, r.waiting, { always: true }),
			...detail(ROW.newPrints, r.counts.new, { always: r.waiting > 0 }),
			...detail(ROW.joined, r.counts.joined, { always: r.waiting > 0 }),
			...detail(ROW.updated, r.counts.updated),
			...detail(ROW.unchanged, r.counts.unchanged),
			...detail(ROW.suggestions, r.suggestedNew),
			...detail(ROW.blocked, r.counts.blocked, { tone: 'warn' }),
			...detail(ROW.unreadable, r.counts.undecodable, { tone: 'warn' }),
			...detail(ROW.failedRetried, r.counts.failed ?? 0, { always: r.waiting > 0, tone: 'bad' }),
			...detail('gone: purged', r.gone.purged),
			...detail('gone: kept (another source)', r.gone.kept),
			...detail('gone: failed', r.gone.failed, { tone: 'bad' }),
			...detail('gone: waiting (the stage lacks what a purge needs)', r.gone.waiting, { tone: 'warn' }),
			...detail('gone: edge cache not purged', r.gone.edgeNotPurged, { tone: 'warn' }),
			...detail('forgotten, read again next fetch', r.counts.refetch, { tone: 'warn' })
		]
	}
];
