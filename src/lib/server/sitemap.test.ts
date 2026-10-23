import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { d1FromSqlite } from './pipeline/d1-sqlite.js';
import { robotsTxt, sitemapRows, sitemapXml } from './sitemap.js';

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

	test('robots.txt keeps crawlers off the string and viewer data, and names the sitemap', () => {
		expect(robotsTxt('https://example.com')).toBe(
			'User-agent: *\nDisallow: /prints/*/string\nDisallow: /prints/*/viewer\nDisallow: /quality-levels\n\nSitemap: https://example.com/sitemap.xml\n'
		);
	});
});
