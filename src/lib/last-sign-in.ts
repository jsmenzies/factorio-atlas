/**
 * The service this browser last signed in with, for the "Last used" badge on /login. Kept only in the
 * browser's local storage, never sent to the site, and kept on sign-out; deleting the account clears it.
 *
 * The server says which service it was once, in the URL's fragment (never sent to a server, and no part
 * of the page cache's key): the sign-in callback (lib/server/auth/callback.ts) lands on
 * `<return>#signed-in=<provider>`, and deleting the account on `/#account-deleted`. app.html's inline
 * script stores or clears the value and strips the fragment before the router starts, so keep the key
 * and both marks in step with it.
 */
export const LAST_SIGN_IN_KEY = 'atlas.lastSignIn';

export const ACCOUNT_DELETED_MARK = '#account-deleted';

/** `path` with the sign-in mark. A path with its own fragment keeps it, unmarked: one sign-in goes unremembered. */
export const withSignInMark = (path: string, provider: string) => (path.includes('#') ? path : `${path}#signed-in=${provider}`);

/** The remembered service's id, or null when there is none or storage is blocked. */
export const lastSignIn = (): string | null => {
	try {
		return localStorage.getItem(LAST_SIGN_IN_KEY);
	} catch {
		return null;
	}
};
