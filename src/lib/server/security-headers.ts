/**
 * Security headers on every response the Worker sends, from hooks.server.ts. The Content Security
 * Policy itself comes from SvelteKit (`csp` in vite.config.ts, nonce mode; a cached page keeps the
 * header it was made with, so its nonce still matches); files served without the Worker (/_app/,
 * static/) get these from `_headers` in the project root.
 */
export const SECURITY_HEADERS: Record<string, string> = {
	// One year. includeSubDomains reaches only this host's own subdomains (renders, sprites), all HTTPS.
	'strict-transport-security': 'max-age=31536000; includeSubDomains',
	'x-content-type-options': 'nosniff',
	// Other sites see the origin, never a search URL. Imgur images set their own no-referrer.
	'referrer-policy': 'strict-origin-when-cross-origin',
	// The CSP's frame-ancestors 'none', for browsers that predate it.
	'x-frame-options': 'DENY',
	'permissions-policy': 'camera=(), microphone=(), geolocation=()',
	'cross-origin-opener-policy': 'same-origin'
};

/** The response with SECURITY_HEADERS set, copied first when its headers are immutable (e.g. redirects). */
export const withSecurityHeaders = (response: Response) => {
	let out = response;
	try {
		for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
	} catch {
		out = new Response(response.body, response);
		for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
	}
	return out;
};
