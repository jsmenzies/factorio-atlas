import type { Cookies } from '@sveltejs/kit';
import { decodeFlow, encodeFlow, FLOW_MAX_AGE_S, type Flow } from './oauth.js';
import { flowCookieName, HINT_COOKIE, sessionCookieName } from './sessions.js';

/**
 * The session and hint cookies (lib/server/auth/sessions.ts). SameSite=Lax so the provider's redirect
 * back (a top-level GET from another site) still carries the flow cookie, and cross-site POSTs carry
 * no session; SvelteKit's origin check refuses those too.
 */
export const setSessionCookies = (cookies: Cookies, token: string, expiresAt: number, dev: boolean) => {
	const options = { path: '/', secure: !dev, sameSite: 'lax', expires: new Date(expiresAt) } as const;
	cookies.set(sessionCookieName(dev), token, { ...options, httpOnly: true });
	cookies.set(HINT_COOKIE, '1', { ...options, httpOnly: false });
};

export const clearHintCookie = (cookies: Cookies, dev: boolean) => cookies.delete(HINT_COOKIE, { path: '/', secure: !dev });

export const hasHintCookie = (cookies: Cookies) => cookies.get(HINT_COOKIE) !== undefined;

export const clearSessionCookies = (cookies: Cookies, dev: boolean) => {
	cookies.delete(sessionCookieName(dev), { path: '/', secure: !dev });
	clearHintCookie(cookies, dev);
};

export const sessionToken = (cookies: Cookies, dev: boolean) => cookies.get(sessionCookieName(dev));

export const setFlowCookie = (cookies: Cookies, flow: Flow, dev: boolean) =>
	cookies.set(flowCookieName(dev), encodeFlow(flow), { path: '/', httpOnly: true, secure: !dev, sameSite: 'lax', maxAge: FLOW_MAX_AGE_S });

/** The sign-in in progress, if any; read once, so the cookie goes. */
export const takeFlowCookie = (cookies: Cookies, dev: boolean) => {
	const flow = decodeFlow(cookies.get(flowCookieName(dev)));
	cookies.delete(flowCookieName(dev), { path: '/', secure: !dev });
	return flow;
};
