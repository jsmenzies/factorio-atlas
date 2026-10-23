/**
 * Per-visitor request limits, run from hooks.server.ts after the /admin guard, so they cover pages
 * and their `__data.json` alike. Two Workers Rate Limiting bindings (wrangler.jsonc `ratelimits`,
 * provisioned by alchemy.run.ts): every request counts towards PAGE_LIMIT, and searches (the home
 * route with a query string, and a quality chip's counts) towards SEARCH_LIMIT as well. Counts are kept per Cloudflare location
 * and are approximate. The zone's WAF rule (alchemy.run.ts) stops floods before they reach the Worker.
 */

/** The parts of a Rate Limiting binding used here. */
export interface Limiter {
	limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Limiters {
	PAGE_LIMIT?: Limiter;
	SEARCH_LIMIT?: Limiter;
}

/**
 * The key a visitor is counted under: the IPv4 address, or the /64 of an IPv6 one, since a single
 * connection is usually handed a whole /64 and could rotate through it. IPv4-mapped IPv6 counts as
 * its IPv4 address.
 */
export const visitorKey = (ip: string) => {
	if (!ip.includes(':')) return ip;
	const last = ip.slice(ip.lastIndexOf(':') + 1);
	if (last.includes('.')) return last;
	const [head, tail] = ip.split('::');
	const h = head ? head.split(':') : [];
	const t = tail ? tail.split(':') : [];
	const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
	return `${groups
		.slice(0, 4)
		.map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''))
		.join(':')}::/64`;
};

/**
 * Routes that serve immutable files (render tiles and overviews, icons, screenshots) when their bucket
 * has no custom domain. A viewer zoom asks for dozens of tiles at once, and a page of search results
 * for 60 card images, so they don't count; with the domains set (prod) they never reach the Worker anyway.
 */
const UNLIMITED_ROUTES = new Set(['/prints/[id]/render/[...file]', '/sprites/[...key]', '/screenshots/[...key]']);

/**
 * A search: the home route with any query string (the bare home page is a cheap read of facet counts), or
 * a quality chip's counts (`/quality-levels`), which run the chip's search five times.
 */
export const isSearch = (routeId: string | null, url: URL) => (routeId === '/' && url.search.length > 1) || routeId === '/quality-levels';

/** Null when the request may go on, else the 429 to send. No limiter (local dev), no client IP or a file route: never limited. */
export const rateLimited = async (request: Request, routeId: string | null, url: URL, limiters: Limiters) => {
	const ip = request.headers.get('cf-connecting-ip');
	if (!ip || (routeId !== null && UNLIMITED_ROUTES.has(routeId))) return null;
	const key = visitorKey(ip);
	const checks = [limiters.PAGE_LIMIT, isSearch(routeId, url) ? limiters.SEARCH_LIMIT : undefined];
	for (const limiter of checks) {
		if (limiter && !(await limiter.limit({ key })).success) {
			return new Response('Too many requests. Please wait a minute and try again.\n', {
				status: 429,
				headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60', 'cache-control': 'no-store' }
			});
		}
	}
	return null;
};
