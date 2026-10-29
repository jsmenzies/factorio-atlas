/**
 * The reports queue (migration 0021 `reports`): reports stored from the public forms, and what
 * /admin/reports reads and decides. Each report has a subject (a print, an image or an account); a
 * subject's open reports are decided together. Approving a removal request (kind 'removal' about a
 * print) runs `takedownPrint`; the request counts as applied only once every step, the edge-cache purge
 * included, has succeeded. Uploads' reports about images and accounts reuse the table, `createReport`
 * and `decide`, and add their own action on approval. Shapes and limits shared with the pages are in
 * src/lib/reports.ts.
 */
import {
	CONTACT_KEEP_DAYS,
	OPEN_PER_SUBJECT_MAX,
	PURGE_ONLY,
	type RemovalReason,
	type ReportKind,
	type ReportStatus,
	type SubjectKind
} from '#lib/reports.js';
import { TakedownError, takedownPrint, type PurgeList, type TakedownEnv, type TakedownResult } from './takedown';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** 16 random base62 characters. */
export const newReportId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => ALPHABET[b % 62]).join('');

export interface NewReport {
	readonly kind: ReportKind;
	readonly subjectKind: SubjectKind;
	readonly subjectId: string;
	/** The print concerned, if any (the subject itself for a print). */
	readonly printId: string | null;
	readonly reason: string;
	readonly details: string | null;
	readonly contact: string | null;
	readonly reporterUserId: string | null;
	readonly now?: number;
}

/**
 * Store a report: 'stored', or 'capped' when its subject already has OPEN_PER_SUBJECT_MAX open reports
 * (the sender is told it was received: one more adds nothing for the admin). The caller checks the
 * subject exists.
 */
export async function createReport(db: D1Database, r: NewReport): Promise<'stored' | 'capped'> {
	const open = await db
		.prepare(`SELECT count(*) AS n FROM reports WHERE subject_kind = ? AND subject_id = ? AND status = 'open'`)
		.bind(r.subjectKind, r.subjectId)
		.first<{ n: number }>();
	if ((open?.n ?? 0) >= OPEN_PER_SUBJECT_MAX) return 'capped';
	await db
		.prepare(
			`INSERT INTO reports (id, kind, subject_kind, subject_id, print_id, reason, details, contact, reporter_user_id, status, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
		)
		.bind(
			newReportId(),
			r.kind,
			r.subjectKind,
			r.subjectId,
			r.printId,
			r.reason,
			r.details,
			r.contact,
			r.reporterUserId,
			r.now ?? Date.now()
		)
		.run();
	return 'stored';
}

export interface NewRemovalRequest {
	readonly printId: string;
	readonly reason: RemovalReason;
	readonly details: string | null;
	readonly contact: string | null;
	readonly reporterUserId: string | null;
	readonly now?: number;
}

/** A removal request from the print page: `createReport`, or 'missing' for a print that isn't on the site. */
export async function createRemovalRequest(db: D1Database, r: NewRemovalRequest): Promise<'stored' | 'capped' | 'missing'> {
	const print = await db.prepare('SELECT 1 AS n FROM prints WHERE id = ?').bind(r.printId).first();
	if (!print) return 'missing';
	return createReport(db, { ...r, kind: 'removal', subjectKind: 'print', subjectId: r.printId, printId: r.printId });
}

export interface ReportRow {
	id: string;
	kind: ReportKind;
	subject_kind: SubjectKind;
	subject_id: string;
	print_id: string | null;
	reason: string;
	details: string | null;
	contact: string | null;
	reporter_user_id: string | null;
	status: ReportStatus;
	created_at: number;
	decided_at: number | null;
	decided_by: string | null;
	note: string | null;
	applied_at: number | null;
	/** JSON PurgeList, while an approved report isn't applied. */
	pending_purge: string | null;
	apply_error: string | null;
}

/** A subject with its open reports, and what the admin needs to recognise it. */
export interface QueueEntry {
	subjectKind: SubjectKind;
	subjectId: string;
	printId: string | null;
	/** The print concerned; null when there is none or it is no longer on the site. */
	print: { title: string; author_name: string | null; image_id: string | null; favorites: number } | null;
	requests: ReportRow[];
}

const COLUMNS = `id, kind, subject_kind, subject_id, print_id, reason, details, contact, reporter_user_id, status, created_at,
	decided_at, decided_by, note, applied_at, pending_purge, apply_error`;

/**
 * What /admin/reports shows: every open report, grouped by subject (the subject with the oldest report
 * first), and the `recent` decided ones, newest first. One batch.
 */
export async function reportQueue(db: D1Database, recent = 50) {
	const [open, prints, decided] = (await db.batch([
		db.prepare(`SELECT ${COLUMNS} FROM reports WHERE status = 'open' ORDER BY created_at`),
		db.prepare(
			`SELECT id, title, author_name, image_id, favorites FROM prints
			WHERE id IN (SELECT print_id FROM reports WHERE status = 'open' AND print_id IS NOT NULL)`
		),
		db.prepare(`SELECT ${COLUMNS} FROM reports WHERE status != 'open' ORDER BY decided_at DESC LIMIT ?`).bind(recent)
	])) as [D1Result<ReportRow>, D1Result<{ id: string } & NonNullable<QueueEntry['print']>>, D1Result<ReportRow>];
	const byId = new Map(prints.results.map(({ id, ...p }) => [id, p]));
	const entries = new Map<string, QueueEntry>();
	for (const r of open.results) {
		const key = `${r.subject_kind}\u0000${r.subject_id}`;
		const e = entries.get(key) ?? {
			subjectKind: r.subject_kind,
			subjectId: r.subject_id,
			printId: r.print_id,
			print: r.print_id === null ? null : (byId.get(r.print_id) ?? null),
			requests: []
		};
		e.requests.push(r);
		entries.set(key, e);
	}
	return { open: [...entries.values()], decided: decided.results };
}

export interface Decision {
	readonly subjectKind: SubjectKind;
	readonly subjectId: string;
	readonly approve: boolean;
	readonly note: string | null;
	/** The Access email when deployed, 'dev' under vite dev. */
	readonly by: string;
	/** For an approved removal: take the screenshot down even when other prints share it. */
	readonly screenshotToo?: boolean;
	readonly now?: number;
}

/**
 * Decide a subject's open reports. A rejection only records it. An approval records it first (so an
 * action that fails part-way leaves the reports approved and not applied, and "Run takedown again"
 * finishes it); for removal requests about a print it then runs the takedown (`applyTakedown`). Other
 * subjects' actions belong to their callers. Returns the takedown's result when one ran.
 */
export async function decide(env: TakedownEnv, d: Decision): Promise<{ decided: number; takedown: TakedownResult | null }> {
	const now = d.now ?? Date.now();
	const { meta } = await env.DB.prepare(
		`UPDATE reports SET status = ?, decided_at = ?, decided_by = ?, note = ? WHERE subject_kind = ? AND subject_id = ? AND status = 'open'`
	)
		.bind(d.approve ? 'approved' : 'rejected', now, d.by, d.note, d.subjectKind, d.subjectId)
		.run();
	const decided = meta.changes ?? 0;
	if (!d.approve || d.subjectKind !== 'print') return { decided, takedown: null };
	return { decided, takedown: await applyTakedown(env, d.subjectId, d.screenshotToo ?? false, now) };
}

/** Approved removal requests of a print whose takedown hasn't finished. */
const UNAPPLIED = `subject_kind = 'print' AND subject_id = ? AND kind = 'removal' AND status = 'approved' AND applied_at IS NULL`;

const parsePurge = (s: string | null): PurgeList => {
	try {
		const p = JSON.parse(s ?? '') as Partial<PurgeList>;
		return { prefixes: Array.isArray(p.prefixes) ? p.prefixes : [], urls: Array.isArray(p.urls) ? p.urls : [] };
	} catch {
		return { prefixes: [], urls: [] };
	}
};

/**
 * Run (or finish) the takedown of a print whose removal was approved. Its requests become applied only
 * when every step succeeded and the edge cache was purged; otherwise they keep what is still to purge
 * (merged with what earlier runs couldn't purge, which this run purges too) and the error, and the admin
 * page offers to run it again. A takedown that throws records its error and throws on.
 */
export async function applyTakedown(env: TakedownEnv, printId: string, screenshotToo: boolean, now = Date.now()) {
	const [latest, pendingRows] = (await env.DB.batch([
		env.DB.prepare(
			`SELECT id FROM reports WHERE subject_kind = 'print' AND subject_id = ? AND kind = 'removal' AND status = 'approved'
			ORDER BY decided_at DESC, created_at LIMIT 1`
		).bind(printId),
		env.DB.prepare(`SELECT pending_purge FROM reports WHERE ${UNAPPLIED} AND pending_purge IS NOT NULL`).bind(printId)
	])) as [D1Result<{ id: string }>, D1Result<{ pending_purge: string }>];
	const earlier = pendingRows.results.map((r) => parsePurge(r.pending_purge));
	const purgeAlso: PurgeList = {
		prefixes: [...new Set(earlier.flatMap((p) => p.prefixes))],
		urls: [...new Set(earlier.flatMap((p) => p.urls))]
	};
	let result: TakedownResult;
	try {
		result = await takedownPrint(env, printId, latest.results[0]?.id ?? null, { screenshotToo, now, purgeAlso });
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		const pending = e instanceof TakedownError ? e.purge : purgeAlso;
		await env.DB.prepare(`UPDATE reports SET pending_purge = ?, apply_error = ? WHERE ${UNAPPLIED}`)
			.bind(JSON.stringify(pending), message.slice(0, 500), printId)
			.run();
		throw e;
	}
	if (result.purged) {
		await env.DB.prepare(`UPDATE reports SET applied_at = ?, pending_purge = NULL, apply_error = NULL WHERE ${UNAPPLIED}`)
			.bind(Date.now(), printId)
			.run();
	} else {
		await env.DB.prepare(`UPDATE reports SET pending_purge = ?, apply_error = ? WHERE ${UNAPPLIED}`)
			.bind(JSON.stringify(result.purge), `${PURGE_ONLY}${result.purgeError ?? 'not purged'}`.slice(0, 500), printId)
			.run();
	}
	return result;
}

/**
 * The admin purged by hand (Custom Purge in the dashboard) what a finished takedown couldn't: its requests
 * are applied. Only when the purge was all that was left (`apply_error` starts with PURGE_ONLY): a
 * takedown that stopped with an error has to run again.
 */
export const markPurgedByHand = (db: D1Database, printId: string, now = Date.now()) =>
	db
		.prepare(
			`UPDATE reports SET applied_at = ?, pending_purge = NULL, apply_error = NULL WHERE ${UNAPPLIED} AND apply_error LIKE '${PURGE_ONLY}%'`
		)
		.bind(now, printId)
		.run();

/**
 * Clear what reporters wrote (contact and details) from reports decided over CONTACT_KEEP_DAYS ago
 * (the daily cron, src/cron/views.ts).
 */
export const clearOldReportText = (db: D1Database, now = Date.now()) =>
	db
		.prepare(`UPDATE reports SET contact = NULL, details = NULL WHERE decided_at < ? AND (contact IS NOT NULL OR details IS NOT NULL)`)
		.bind(now - CONTACT_KEEP_DAYS * 86_400_000)
		.run();
