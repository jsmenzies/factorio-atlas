/**
 * `locals.account` (hooks.server.ts): who is signed in, read from the session cookie the first time a
 * route asks, at most once per request. On a route the page cache keeps (lib/server/page-cache.ts),
 * asking throws: a cached page is the same for everyone, so its load must never depend on, or set
 * cookies for, a session. Ask from a route that isn't cached (`/me`, a form action) instead.
 */
import type { Cookies } from '@sveltejs/kit';
import { clearHintCookie, clearSessionCookies, hasHintCookie, sessionToken, setSessionCookies } from './cookies.js';
import { readSession } from './sessions.js';
import type { Account } from './users.js';

export const CACHED_ROUTE_READ = 'cached route read the session';

export type AccountReader = () => Promise<Account | null>;

export const accountReader = (db: D1Database, cookies: Cookies, dev: boolean, cached: boolean): AccountReader => {
	if (cached)
		return () => {
			throw new Error(CACHED_ROUTE_READ);
		};
	let account: Promise<Account | null> | undefined;
	return () =>
		(account ??= (async () => {
			const token = sessionToken(cookies, dev);
			if (!token) {
				if (hasHintCookie(cookies)) clearHintCookie(cookies, dev);
				return null;
			}
			const session = await readSession(db, token);
			if (!session) {
				clearSessionCookies(cookies, dev);
				return null;
			}
			if (session.refreshed) setSessionCookies(cookies, token, session.expiresAt, dev);
			return session.account;
		})());
};
