/**
 * The admin's view of site accounts (/admin/accounts; migrations 0023, 0024): each account with its
 * sign-in providers, sessions and uploads, read in one D1 batch with aggregate subqueries per row (no
 * query per account). It shows only what the privacy page says the site keeps: provider names (never
 * the provider's user id), the display name, when the account was made, its sessions' expiry times, and
 * its uploads. Sessions record no visits, so "last seen" is the latest time a session started or was
 * renewed: its expiry less SESSION_DAYS (sessions.ts readSession renews one used with under half its
 * life left, so the last visit lies between that and SESSION_DAYS / 2 later).
 *
 * Deleting an account goes through the owner's own path (uploads.ts deleteAccountStep).
 */
import { isProvider, SPECS } from '../auth/providers';
import { SESSION_DAYS } from '../auth/sessions';
import { deleteAccountStep, uploadsOf, type UploadRow } from '../uploads/uploads';

export const ACCOUNTS_PAGE_SIZE = 100;
/** Longest search text, so a pasted essay isn't a LIKE pattern. */
export const ACCOUNT_SEARCH_MAX = 64;
const DAY_MS = 86_400_000;
const SESSION_MS = SESSION_DAYS * DAY_MS;

export interface AccountSummary {
	id: string;
	name: string;
	createdAt: number;
	bannedAt: number | null;
	deletingAt: number | null;
	/** Provider labels ("GitHub", "Test sign-in"), in a fixed order. */
	providers: string[];
	/** Unexpired sessions. */
	sessions: number;
	/** The latest session start or renewal, or null when no session row is left (signed out, or expired and swept). */
	lastSeen: number | null;
	uploads: { live: number; processing: number; refused: number; failed: number };
	/** Screenshots of its uploads waiting for an admin (distinct images). */
	pendingScreenshots: number;
}

interface SummaryRow {
	id: string;
	name: string;
	created_at: number;
	banned_at: number | null;
	deleting_at: number | null;
	providers: string | null;
	sessions: number;
	last_expiry: number | null;
	uploads: string;
}

/**
 * One row per account. ?1 is now. Each subquery reads one account's rows through its own index:
 * user_identities_user, sessions_user, uploads_user, then upload_images by primary key.
 */
const SUMMARY_SQL = `SELECT u.id, u.name, u.created_at, u.banned_at, u.deleting_at,
	(SELECT group_concat(provider) FROM user_identities WHERE user_id = u.id) AS providers,
	(SELECT count(*) FROM sessions WHERE user_id = u.id AND expires_at > ?1) AS sessions,
	(SELECT max(expires_at) FROM sessions WHERE user_id = u.id) AS last_expiry,
	(SELECT json_object(
		'live', count(*) FILTER (WHERE up.state = 'live'),
		'processing', count(*) FILTER (WHERE up.state = 'processing'),
		'refused', count(*) FILTER (WHERE up.state = 'refused'),
		'failed', count(*) FILTER (WHERE up.state = 'failed'),
		'pending', count(DISTINCT i.id) FILTER (WHERE i.status = 'pending'))
		FROM uploads up LEFT JOIN upload_images i ON i.id = up.image_id WHERE up.user_id = u.id) AS uploads
	FROM users u`;

const PROVIDER_ORDER = ['discord', 'github', 'google', 'dev'];
const providerLabel = (p: string) => (isProvider(p) ? SPECS[p].label : p === 'dev' ? 'Test sign-in' : p);

const summaryOf = (r: SummaryRow): AccountSummary => {
	const u = JSON.parse(r.uploads) as Record<'live' | 'processing' | 'refused' | 'failed' | 'pending', number>;
	return {
		id: r.id,
		name: r.name,
		createdAt: r.created_at,
		bannedAt: r.banned_at,
		deletingAt: r.deleting_at,
		providers: (r.providers ?? '')
			.split(',')
			.filter(Boolean)
			.sort((a, b) => PROVIDER_ORDER.indexOf(a) - PROVIDER_ORDER.indexOf(b))
			.map(providerLabel),
		sessions: r.sessions,
		lastSeen: r.last_expiry === null ? null : r.last_expiry - SESSION_MS,
		uploads: { live: u.live, processing: u.processing, refused: u.refused, failed: u.failed },
		pendingScreenshots: u.pending
	};
};

/** The search box's text as a LIKE pattern for "name contains", case-insensitive (ASCII, as names are). */
const containsPattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** The list's search text, tidied and capped. */
export const accountSearch = (raw: string | null) => (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, ACCOUNT_SEARCH_MAX);

/** The 1-based page number from `?p=`, at least 1. */
export const accountPage = (raw: string | null) => {
	const n = Number.parseInt(raw ?? '', 10);
	return Number.isFinite(n) && n >= 1 ? Math.min(n, 1_000_000) : 1;
};

/** Every account, newest first, `ACCOUNTS_PAGE_SIZE` a page, optionally only names containing `q`: one batch. */
export const accountList = async (
	db: D1Database,
	{ q = '', page = 1, now = Date.now() }: { q?: string; page?: number; now?: number } = {}
) => {
	const pattern = q ? [containsPattern(q)] : [];
	const offset = (Math.max(1, Math.floor(page)) - 1) * ACCOUNTS_PAGE_SIZE;
	const [count, rows] = await db.batch([
		db.prepare(`SELECT count(*) AS n FROM users u${q ? ` WHERE u.name LIKE ?1 ESCAPE '\\'` : ''}`).bind(...pattern),
		db
			.prepare(
				`${SUMMARY_SQL}${q ? ` WHERE u.name LIKE ?2 ESCAPE '\\'` : ''} ORDER BY u.created_at DESC, u.id DESC LIMIT ${ACCOUNTS_PAGE_SIZE} OFFSET ${offset}`
			)
			.bind(now, ...pattern)
	]);
	const total = (count.results[0] as { n: number } | undefined)?.n ?? 0;
	return {
		accounts: (rows.results as SummaryRow[]).map(summaryOf),
		total,
		page,
		pages: Math.max(1, Math.ceil(total / ACCOUNTS_PAGE_SIZE))
	};
};

/** One account's facts and its uploads, newest first (one batch); null when there is no such account. */
export const accountDetail = async (db: D1Database, userId: string, now = Date.now()) => {
	const [row, uploads] = await db.batch([db.prepare(`${SUMMARY_SQL} WHERE u.id = ?2`).bind(now, userId), uploadsOf(db, userId)]);
	const r = row.results[0] as SummaryRow | undefined;
	return r ? { account: summaryOf(r), uploads: uploads.results as UploadRow[] } : null;
};

/** Signs an account out everywhere: deletes all its sessions. The count deleted. */
export const endSessions = async (db: D1Database, userId: string) =>
	(await db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run()).meta.changes ?? 0;

export type AdminDeleteResult =
	| { ok: false; status: 400 | 404; problem: string }
	| { ok: true; name: string; deleted: number; left: number; done: boolean };

/**
 * An admin deletes an account: the owner's own path (uploads.ts deleteAccountStep), one step a call. The
 * first step needs the account's name typed exactly; once the account is marked deleting (by this or by
 * its owner), later steps go on without it.
 */
export const adminDeleteAccount = async (
	deps: Parameters<typeof deleteAccountStep>[0],
	userId: string,
	typedName: string | null,
	options?: Parameters<typeof deleteAccountStep>[2]
): Promise<AdminDeleteResult> => {
	const row = await deps.db
		.prepare(`SELECT name, deleting_at FROM users WHERE id = ?`)
		.bind(userId)
		.first<{ name: string; deleting_at: number | null }>();
	if (!row) return { ok: false, status: 404, problem: 'No such account.' };
	if (row.deleting_at === null && (typedName ?? '').trim() !== row.name)
		return { ok: false, status: 400, problem: 'Type the account’s name exactly as shown to confirm.' };
	return { ok: true, name: row.name, ...(await deleteAccountStep(deps, userId, options)) };
};
