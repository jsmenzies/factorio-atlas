import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { d1FromSqlite } from './pipeline/d1-sqlite.js';
import { robotsTxt, sitemapRows, sitemapXml } from './sitemap.js';
import { landingPath } from '#lib/search-seo.js';

describe('sitemap', () => {
	test('home page first, then every print with its lastmod', () => {
		const xml = sitemapXml('https://example.com', [
			{ id: '-KnQ865j-qQ21WoUPbd3', updated_at: Date.UTC(2026, 9, 1) },
			{ id: '-LV4ZJpfgpKKUkyodKiz', updated_at: null }
		]);
		expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')).toBe(
			true
		);
		const urls = [...xml.matchAll(/<url>(.*?)<\/url>/g)].map((m) => m[1]);
		expect(urls).toEqual([
			'<loc>https://example.com/</loc>',
			'<loc>https://example.com/prints/-KnQ865j-qQ21WoUPbd3</loc><lastmod>2026-10-01T00:00:00.000Z</lastmod>',
			'<loc>https://example.com/prints/-LV4ZJpfgpKKUkyodKiz</loc>'
		]);
		expect(xml.endsWith('</urlset>\n')).toBe(true);
	});

	test('ids are URL-encoded and XML-escaped', () => {
		const xml = sitemapXml('https://example.com', [{ id: 'a&b<c', updated_at: null }]);
		expect(xml).toContain('<loc>https://example.com/prints/a%26b%3Cc</loc>');
		expect(sitemapXml('https://example.com?x=1&y', [])).toContain('<loc>https://example.com?x=1&amp;y/</loc>');
	});

	test('landing pages come after the home page, before the prints', () => {
		const xml = sitemapXml('https://example.com', [{ id: 'a', updated_at: null }], [{ key: 'makes', value: 'item:electronic-circuit' }]);
		expect([...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1])).toEqual([
			'https://example.com/',
			'https://example.com/?makes=item%3Aelectronic-circuit',
			'https://example.com/prints/a'
		]);
	});

	test('reads every print and the makes/uses values with enough prints from D1', async () => {
		const sqlite = new Database(':memory:');
		sqlite.run('CREATE TABLE prints (id TEXT PRIMARY KEY, updated_at INTEGER)');
		sqlite.run("INSERT INTO prints VALUES ('b', 2), ('a', NULL)");
		sqlite.run('CREATE TABLE facet_counts (kind TEXT, value TEXT, n INTEGER)');
		sqlite.run(
			"INSERT INTO facet_counts VALUES ('makes', 'item:rail', 3), ('makes', 'item:pipe', 2), ('uses', 'entity:foundry', 9), ('version', '2.0', 50)"
		);
		expect(await sitemapRows(d1FromSqlite(sqlite))).toEqual({
			prints: [
				{ id: 'a', updated_at: null },
				{ id: 'b', updated_at: 2 }
			],
			landings: [
				{ key: 'makes', value: 'item:rail' },
				{ key: 'uses', value: 'entity:foundry' }
			]
		});
	});

	test('robots.txt names the sitemap', () => {
		expect(robotsTxt('https://example.com').endsWith('\nSitemap: https://example.com/sitemap.xml\n')).toBe(true);
	});

	/** RFC 9309 matching, as Google and Bing do it: the longest matching rule wins, Allow on a tie; `*` is any run, `$` the end. */
	const allowed = (robots: string, url: string) => {
		const rules = robots
			.split('\n')
			.map((line) => /^(Allow|Disallow): (.+)$/.exec(line))
			.filter((m) => m !== null)
			.map(([, kind, path]) => ({ allow: kind === 'Allow', path }));
		const matches = rules.filter(({ path }) => {
			const end = path.endsWith('$');
			const body = (end ? path.slice(0, -1) : path).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
			return new RegExp(`^${body}${end ? '$' : ''}`).test(url);
		});
		const best = matches.sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow))[0];
		return best?.allow ?? true;
	};

	test('robots.txt lets crawlers fetch the home page, landing pages and prints, and nothing else in search', () => {
		const robots = robotsTxt('https://example.com');
		const open = [
			'/',
			landingPath({ key: 'makes', value: 'item:rocket-fuel' }),
			landingPath({ key: 'uses', value: 'entity:foundry' }),
			'/prints/-LI0gc-a-2_VLWR-tx1d',
			'/prints/-LI0gc-a-2_VLWR-tx1d?page=5',
			'/sitemap.xml',
			'/robots.txt',
			'/og.png'
		];
		const closed = [
			'/?q=red%20science',
			'/?p=2',
			'/?sort=popular',
			'/?author=SWFBEjQvP7aHu91wPxwryXXflTf2',
			'/?render=1',
			'/?version=2.0',
			'/?makes=item%3Arocket-fuel&version=2.0.77',
			'/?makes=item%3Arocket-fuel&makes=item%3Asolid-fuel',
			'/?makes=item%3Arocket-fuel&p=2',
			'/?uses=entity%3Afoundry&spaceAge=yes',
			'/?uses=entity%3Abeacon%40epic',
			'/?uses=entity:beacon@epic',
			'/?render=1&makes=item%3Arocket-fuel',
			'/prints/-LI0gc-a-2_VLWR-tx1d/render?page=0',
			'/prints/-LI0gc-a-2_VLWR-tx1d/render?page=0&from=overview',
			'/prints/-LI0gc-a-2_VLWR-tx1d/remove',
			'/prints/-LI0gc-a-2_VLWR-tx1d/string?page=1',
			'/prints/-LI0gc-a-2_VLWR-tx1d/viewer',
			'/quality-levels?uses=entity%3Abeacon'
		];
		expect(open.filter((url) => !allowed(robots, url))).toEqual([]);
		expect(closed.filter((url) => allowed(robots, url))).toEqual([]);
	});
});
