/**
 * Sessions (migration 0023): a random token in an HttpOnly cookie, its SHA-256 in D1. A session lasts
 * SESSION_DAYS and is extended when used with less than half of that left. Only routes that ask for
 * the account (`locals.account()`, lib/server/auth/locals.ts) read it; on the cached routes asking
 * throws, so cached pages never touch D1 or set cookies for it.
 *
 * Beside it, a readable `atlas_signed_in=1` cookie holds no secret: it only lets the page show
 * "Account" rather than "Sign in" before it has asked `/me` who is signed in (app.html).
 */
import { randomToken } from './oauth';
import { accountOf, NAME_HOLD_DAYS, type Account, type AccountRow } from './users';

export const SESSION_DAYS = 30;
/** Signed-in browsers per account; signing in on one more ends the oldest. */
export const SESSIONS_PER_USER = 20;
const DAY_MS = 86_400_000;

/** `__Host-` pins the cookie to this host, https and path /; plain http under vite dev can't set it. */
export const sessionCookieName = (dev: boolean) => (dev ? 'atlas_session' : '__Host-atlas_session');
export const HINT_COOKIE = 'atlas_signed_in';
export const flowCookieName = (dev: boolean) => (dev ? 'atlas_oauth' : '__Host-atlas_oauth');

export const hashToken = async (token: string) =>
	[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');

/**
 * Starts a session; the token goes in the cookie and is never stored. `replacing` is the browser's
 * current session token, if any (signing in again): that session ends. The account keeps at most
 * SESSIONS_PER_USER, newest first.
 */
export const createSession = async (db: D1Database, userId: string, now = Date.now(), replacing?: string) => {
	const token = randomToken();
	const expiresAt = now + SESSION_DAYS * DAY_MS;
	await db.batch([
		...(replacing ? [db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(await hashToken(replacing))] : []),
		// The account's expired sessions, and all but its newest SESSIONS_PER_USER - 1, go before the new one.
		db
			.prepare(
				`DELETE FROM sessions WHERE user_id = ?1 AND (expires_at <= ?2 OR token_hash NOT IN (
					SELECT token_hash FROM sessions WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?3))`
			)
			.bind(userId, now, SESSIONS_PER_USER - 1),
		db
			.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
			.bind(await hashToken(token), userId, now, expiresAt)
	]);
	return { token, expiresAt };
};

export interface Session {
	account: Account;
	expiresAt: number;
	/** Extended by this read, so the cookie needs its new expiry. */
	refreshed: boolean;
}

/**
 * The signed-in account, or null for a missing, expired or unknown token or a banned account. A
 * session with under half its life left is extended (`expiresAt` is then the new end, for the cookie).
 */
export const readSession = async (db: D1Database, token: string, now = Date.now()): Promise<Session | null> => {
	const hash = await hashToken(token);
	const row = await db
		.prepare(
			`SELECT s.expires_at, u.id, u.name, u.banned_at, u.deleting_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
		)
		.bind(hash)
		.first<AccountRow & { expires_at: number }>();
	if (!row) return null;
	if (row.expires_at <= now || row.banned_at !== null) {
		await db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(hash).run();
		return null;
	}
	const account = accountOf(row);
	if (row.expires_at - now >= (SESSION_DAYS * DAY_MS) / 2) return { account, expiresAt: row.expires_at, refreshed: false };
	const expiresAt = now + SESSION_DAYS * DAY_MS;
	await db.prepare(`UPDATE sessions SET expires_at = ? WHERE token_hash = ?`).bind(expiresAt, hash).run();
	return { account, expiresAt, refreshed: true };
};

export const deleteSession = async (db: D1Database, token: string) => {
	await db
		.prepare(`DELETE FROM sessions WHERE token_hash = ?`)
		.bind(await hashToken(token))
		.run();
};

/**
 * The daily cron's account chores (src/cron/views.ts): expired sessions, name holds past
 * NAME_HOLD_DAYS, and upload counts of past days. Never throws, so it can't hold up the views sync;
 * a failure is logged and the next day's run catches up.
 */
export const accountChores = async (db: D1Database, now = Date.now()) => {
	try {
		const [sessions, names, quota] = await db.batch([
			db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).bind(now),
			db.prepare(`DELETE FROM released_names WHERE released_at <= ?`).bind(now - NAME_HOLD_DAYS * DAY_MS),
			// Upload counts (migration 0024) of days before yesterday: only today's count.
			db.prepare(`DELETE FROM upload_quota WHERE day < ?`).bind(Math.floor(now / DAY_MS) - 1)
		]);
		console.log(
			`accounts: ${sessions.meta.changes ?? 0} expired sessions, ${names.meta.changes ?? 0} name holds and ${quota.meta.changes ?? 0} old upload counts deleted`
		);
	} catch (e) {
		console.error(`accounts: daily chores failed: ${e instanceof Error ? e.message : String(e)}`);
	}
};
