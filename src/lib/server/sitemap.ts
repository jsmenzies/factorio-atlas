/**
 * /sitemap.xml and /robots.txt. Search shows at most a page of results, so crawlers find most
 * prints only through the sitemap. URLs are built from the request's origin.
 */
import { landingPath, type Landing } from '#lib/search-seo.js';

export interface SitemapPrint {
	id: string;
	/** factorioprints' lastUpdatedDate, Unix ms. */
	updated_at: number | null;
}

/** Landing pages with fewer prints than this stay out of the sitemap (they're still indexable if found). */
export const LANDING_MIN_PRINTS = 3;

/**
 * Every print, by id, and the `makes`/`uses` values with at least LANDING_MIN_PRINTS prints. A
 * deliberate full read (≈ one row per print), in one batch; the route caches the result.
 */
export const sitemapRows = async (db: D1Database): Promise<{ prints: SitemapPrint[]; landings: Landing[] }> => {
	const [prints, landings] = await db.batch([
		db.prepare('SELECT id, updated_at FROM prints ORDER BY id'),
		db
			.prepare(`SELECT kind AS key, value FROM facet_counts WHERE kind IN ('makes', 'uses') AND n >= ? ORDER BY kind, value`)
			.bind(LANDING_MIN_PRINTS)
	]);
	return { prints: prints.results as unknown as SitemapPrint[], landings: landings.results as unknown as Landing[] };
};

const escapeXml = (s: string) =>
	s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c);

const entry = (loc: string, lastmod?: number | null) =>
	`<url><loc>${escapeXml(loc)}</loc>${lastmod ? `<lastmod>${new Date(lastmod).toISOString()}</lastmod>` : ''}</url>`;

/**
 * The home page, the landing pages, then one URL per print. Up to 50,000 URLs fit one file; past
 * that it needs a sitemap index.
 */
export const sitemapXml = (origin: string, prints: SitemapPrint[], landings: Landing[] = []) =>
	[
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
		entry(`${origin}/`),
		...landings.map((l) => entry(`${origin}${landingPath(l)}`)),
		...prints.map((p) => entry(`${origin}/prints/${encodeURIComponent(p.id)}`, p.updated_at)),
		'</urlset>',
		''
	].join('\n');

/**
 * Crawlers may fetch the home page, landing pages (lib/search-seo.ts) and print pages. Kept off: the blueprint
 * strings, the inline viewer's JSON and a quality chip's counts (data for the page's own scripts, also sent with
 * `X-Robots-Tag: noindex`), and every `noindex` page with a crawlable link to it: the full-screen render pages
 * and searches other than a landing page. `nofollow` on links into search is only a hint: Googlebot crawled
 * ≈ 160k of those noindex pages in the site's first week while the prints waited. The longest matching rule
 * wins (RFC 9309), so a landing page (`/?makes=<one value>`, `/?uses=<one value>`) is allowed, and the same
 * with a second parameter (`&`) or a quality (`@`, `%40`) is not.
 */
export const robotsTxt = (origin: string) =>
	[
		'User-agent: *',
		'Disallow: /prints/*/string',
		'Disallow: /prints/*/viewer',
		'Disallow: /prints/*/render',
		'Disallow: /prints/*/remove',
		'Disallow: /quality-levels',
		'Disallow: /?',
		...['makes', 'uses'].flatMap((key) => [
			`Allow: /?${key}=`,
			`Disallow: /?${key}=*&`,
			`Disallow: /?${key}=*@`,
			`Disallow: /?${key}=*%40`
		]),
		'',
		`Sitemap: ${origin}/sitemap.xml`,
		''
	].join('\n');
