import { describe, expect, test } from 'bun:test';
import { isSearch, rateLimited, visitorKey, type Limiter } from './rate-limit.js';

describe('visitorKey', () => {
	for (const [ip, key] of [
		['203.0.113.7', '203.0.113.7'],
		['2001:db8:85a3:0042:1000:8a2e:0370:7334', '2001:db8:85a3:42::/64'],
		['2001:DB8::1', '2001:db8:0:0::/64'],
		['2001:db8:1:2::', '2001:db8:1:2::/64'],
		['::1', '0:0:0:0::/64'],
		['::ffff:198.51.100.4', '198.51.100.4']
	]) {
		test(`${ip} → ${key}`, () => expect(visitorKey(ip)).toBe(key));
	}
	test('one /64 is one visitor', () => expect(visitorKey('2001:db8:1:2:a::1')).toBe(visitorKey('2001:db8:1:2:ffff::9')));
});

describe('isSearch', () => {
	test('home with a query string', () => expect(isSearch('/', new URL('https://example.com/?makes=gear'))).toBe(true));
	test('bare home', () => {
		expect(isSearch('/', new URL('https://example.com/'))).toBe(false);
		expect(isSearch('/', new URL('https://example.com/?'))).toBe(false);
	});
	test('other routes', () => expect(isSearch('/prints/[id]', new URL('https://example.com/prints/x?page=2'))).toBe(false));
});

describe('rateLimited', () => {
	/** A limiter that lets `allow` requests through, recording the keys it saw. */
	const limiter = (allow: number) => {
		const keys: string[] = [];
		const l: Limiter & { keys: string[] } = { keys, limit: async ({ key }) => ({ success: keys.push(key) <= allow }) };
		return l;
	};
	const req = (url: string, ip: string | null = '203.0.113.7') => new Request(url, { headers: ip ? { 'cf-connecting-ip': ip } : {} });

	test('under the limit goes on', async () => {
		const page = limiter(1);
		expect(
			await rateLimited(req('https://example.com/prints/x'), '/prints/[id]', new URL('https://example.com/prints/x'), { PAGE_LIMIT: page })
		).toBe(null);
		expect(page.keys).toEqual(['203.0.113.7']);
	});
	test('over the page limit is a 429', async () => {
		const url = new URL('https://example.com/prints/x');
		const limiters = { PAGE_LIMIT: limiter(1) };
		await rateLimited(req(url.href), '/prints/[id]', url, limiters);
		const res = await rateLimited(req(url.href), '/prints/[id]', url, limiters);
		expect(res?.status).toBe(429);
		expect(res?.headers.get('retry-after')).toBe('60');
	});
	test('searches count towards both limits', async () => {
		const url = new URL('https://example.com/?q=belt');
		const page = limiter(10);
		const search = limiter(0);
		expect((await rateLimited(req(url.href), '/', url, { PAGE_LIMIT: page, SEARCH_LIMIT: search }))?.status).toBe(429);
		expect([page.keys.length, search.keys.length]).toEqual([1, 1]);
	});
	test('pages do not use the search limit', async () => {
		const url = new URL('https://example.com/prints/x');
		const search = limiter(0);
		expect(await rateLimited(req(url.href), '/prints/[id]', url, { PAGE_LIMIT: limiter(1), SEARCH_LIMIT: search })).toBe(null);
		expect(search.keys).toEqual([]);
	});
	test('render files and icons are never limited', async () => {
		const page = limiter(0);
		for (const [path, route] of [
			['/prints/x/render/t/abc.avif', '/prints/[id]/render/[...file]'],
			['/sprites/icons/a/item/gear.webp', '/sprites/[...key]']
		]) {
			const url = new URL(`https://example.com${path}`);
			expect(await rateLimited(req(url.href), route, url, { PAGE_LIMIT: page })).toBe(null);
		}
		expect(page.keys).toEqual([]);
		const url = new URL('https://example.com/prints/x/render');
		expect((await rateLimited(req(url.href), '/prints/[id]/render', url, { PAGE_LIMIT: page }))?.status).toBe(429);
	});
	test('no limiters or no client IP: never limited', async () => {
		const url = new URL('https://example.com/?q=belt');
		expect(await rateLimited(req(url.href), '/', url, {})).toBe(null);
		expect(await rateLimited(req(url.href, null), '/', url, { PAGE_LIMIT: limiter(0) })).toBe(null);
	});
});
