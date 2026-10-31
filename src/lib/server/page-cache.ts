/**
 * Page cache: whole responses of the search and print pages (HTML and the `__data.json` SvelteKit
 * fetches on client-side navigation), kept in the Cloudflare location's Cache API
 * (`caches.default`) by hooks.server.ts, after the /admin guard and the rate limits.
 *
 * Purging is by key, not by deleting: every key carries the build (SvelteKit's `version`, new on
 * each deploy) and the data version (`meta.sync_version` in D1), so a deploy or a bump of the data
 * version makes every location look up new keys at once, and old entries just expire. Anything
 * that changes what pages show bumps it: the ingest and backfill (rebuildFacets), render:flags,
 * the views sync and `bun run authors` (`bumpPageVersion`). The version is read at most once per
 * VERSION_TTL_MS per isolate, so a bump reaches every page within that.
 *
 * Only 200s without Set-Cookie are stored. Browsers get `no-cache`, so they never keep a page past a
 * purge, except for the JSON endpoints in BROWSER_KEEPS; `x-page-cache` says hit or miss. A cached page keeps the CSP header (and nonce) it was
 * made with, which still matches its HTML.
 */

/** Cached routes and how long a location keeps an entry (seconds). A purge needs no wait either way. */
export const CACHED_ROUTES: Record<string, number> = {
	'/': 3600,
	'/prints/[id]': 86_400,
	'/prints/[id]/render': 86_400,
	// JSON the pages fetch: the inline viewer's page (three R2 reads, up to ≈ 1 MB) and a quality chip's counts.
	'/prints/[id]/viewer': 300,
	'/quality-levels': 300
};

/**
 * Cached routes whose responses browsers keep too (`public, max-age=<ttl>`), as they did before these
 * were cached here: fetched by a page, never navigated to, and short-lived, so a purge reaches a browser
 * within that lifetime (twice it at worst, when the location's copy was already old).
 */
export const BROWSER_KEEPS: ReadonlySet<string> = new Set(['/prints/[id]/viewer', '/quality-levels']);

/** How long an isolate reuses the data version it read. */
export const VERSION_TTL_MS = 30_000;

/** The statement that purges every cached page: a new data version. */
export const bumpPageVersion = (db: D1Database, now = Date.now()) =>
	db
		.prepare(`INSERT INTO meta (key, value) VALUES ('sync_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
		.bind(String(now));

let memo: { value: string; at: number } | undefined;

/** `meta.sync_version`, read at most once per VERSION_TTL_MS; '0' before the first bump. */
export const dataVersion = async (db: D1Database, now = Date.now()) => {
	if (memo && now - memo.at < VERSION_TTL_MS) return memo.value;
	const row = await db.prepare(`SELECT value FROM meta WHERE key = 'sync_version'`).first<{ value: string }>();
	memo = { value: row?.value ?? '0', at: now };
	return memo.value;
};

/** For tests: forget the remembered version. */
export const forgetDataVersion = () => {
	memo = undefined;
};

/** Seconds to keep a request's page, or null when it isn't cached. */
export const cacheTtl = (method: string, routeId: string | null) =>
	method === 'GET' && routeId !== null ? (CACHED_ROUTES[routeId] ?? null) : null;

/** The cache key: the request's own path and query (so `__data.json` and HTML differ) under the build and data versions. */
export const pageCacheKey = (requestUrl: string, build: string, data: string) => {
	const u = new URL(requestUrl);
	return new Request(`${u.origin}/__page-cache/${encodeURIComponent(build)}/${encodeURIComponent(data)}${u.pathname}${u.search}`);
};

/** SvelteKit's data for client-side navigation (`…/__data.json`). */
const isDataRequest = (requestUrl: string) => new URL(requestUrl).pathname.endsWith('/__data.json');

/**
 * Whether a response may be kept for every visitor. SvelteKit marks every `__data.json`
 * `private, no-store` in case a load reads cookies; none of the cached routes' loads do (only
 * /admin is per user, and it's never cached), so that default is ignored for them.
 */
export const storable = (res: Response, data = false) => {
	const cc = res.headers.get('cache-control') ?? '';
	return res.status === 200 && !res.headers.has('set-cookie') && (data || !/no-store|private/.test(cc));
};

/** The copy the cache keeps, fresh for `ttl` seconds. */
const forCache = (res: Response, ttl: number) => {
	const out = new Response(res.body, res);
	out.headers.set('cache-control', `public, max-age=${ttl}`);
	return out;
};

/** What the browser gets: never kept past a purge (unless `keepFor`, seconds), and whether it came from the cache. */
const forClient = (res: Response, state: 'hit' | 'miss', keepFor: number | null) => {
	const out = new Response(res.body, res);
	out.headers.set('cache-control', keepFor === null ? 'no-cache' : `public, max-age=${keepFor}`);
	out.headers.set('x-page-cache', state);
	return out;
};

export interface PageCacheDeps {
	cache: Pick<Cache, 'match' | 'put'>;
	db: D1Database;
	/** SvelteKit's `version` (from `$app/env`): new on every build. */
	build: string;
	/** Keeps the Worker alive until the cache write is done (`waitUntil` from cloudflare:workers). */
	waitUntil: (p: Promise<unknown>) => void;
}

/**
 * The cached page for this request, or `render()`'s, stored on the way out when it may be. Any
 * failure of the cache itself falls back to rendering, so the cache can't take the site down.
 * `browserKeeps` (BROWSER_KEEPS) lets the browser keep it for `ttl` too.
 */
export async function cachedPage(
	request: Request,
	ttl: number,
	render: () => Promise<Response>,
	deps: PageCacheDeps,
	browserKeeps = false
) {
	const keepFor = browserKeeps ? ttl : null;
	let key: Request;
	try {
		key = pageCacheKey(request.url, deps.build, await dataVersion(deps.db));
		const hit = await deps.cache.match(key);
		if (hit) return forClient(hit, 'hit', keepFor);
	} catch (e) {
		console.warn(`page cache: lookup failed, rendering: ${e instanceof Error ? e.message : String(e)}`);
		return render();
	}
	const res = await render();
	if (!storable(res, isDataRequest(request.url))) return res;
	deps.waitUntil(
		deps.cache.put(key, forCache(res.clone(), ttl)).catch((e: unknown) => {
			console.warn(`page cache: store failed: ${e instanceof Error ? e.message : String(e)}`);
		})
	);
	return forClient(res, 'miss', keepFor);
}
