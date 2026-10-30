import { describe, expect, test } from 'bun:test';
import { isAuth, isSearch, isUpload, rateLimited, visitorKey, type Limiter } from './rate-limit.js';

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
	test("a quality chip's counts", () =>
		expect(
			isSearch('/quality-levels', new URL('https://example.com/quality-levels?uses=entity:beacon&filter=uses&value=entity:beacon'))
		).toBe(true));
});

describe('isAuth', () => {
	test('every sign-in step, whatever the method', () => {
		for (const route of ['/auth/[provider]', '/auth/[provider]/callback', '/auth/dev']) expect(isAuth(route, 'GET')).toBe(true);
	});
	test('account changes, not account views', () => {
		expect(isAuth('/account', 'POST')).toBe(true);
		expect(isAuth('/account', 'GET')).toBe(false);
		expect(isAuth('/account', 'HEAD')).toBe(false);
	});
	test('other routes, and none', () => {
		for (const route of ['/', '/login', '/me', '/prints/[id]', '/authors', '/upload']) expect(isAuth(route, 'POST')).toBe(false);
		expect(isAuth(null, 'POST')).toBe(false);
	});
});

describe('isUpload', () => {
	test('sending an upload, or an edit or delete of one', () => {
		expect(isUpload('/upload', 'POST')).toBe(true);
		expect(isUpload('/uploads/[id]', 'POST')).toBe(true);
	});
	test('not looking at the forms, nor other routes', () => {
		expect(isUpload('/upload', 'GET')).toBe(false);
		expect(isUpload('/uploads/[id]', 'GET')).toBe(false);
		expect(isUpload('/account', 'POST')).toBe(false);
		expect(isUpload(null, 'POST')).toBe(false);
	});
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
	test("a quality chip's counts use the search limit", async () => {
		const url = new URL('https://example.com/quality-levels?q=red&uses=entity:beacon&filter=uses&value=entity:beacon');
		const search = limiter(0);
		expect((await rateLimited(req(url.href), '/quality-levels', url, { PAGE_LIMIT: limiter(1), SEARCH_LIMIT: search }))?.status).toBe(429);
		expect(search.keys.length).toBe(1);
	});
	test('sign-in steps and sent uploads have their own limits', async () => {
		const post = (url: URL) => new Request(url, { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.7' } });
		const auth = limiter(0);
		const upload = limiter(0);
		const limiters = { PAGE_LIMIT: limiter(10), AUTH_LIMIT: auth, UPLOAD_LIMIT: upload };
		const callback = new URL('https://example.com/auth/github/callback?code=c');
		expect((await rateLimited(req(callback.href), '/auth/[provider]/callback', callback, limiters))?.status).toBe(429);
		const form = new URL('https://example.com/upload');
		expect(await rateLimited(req(form.href), '/upload', form, limiters)).toBe(null);
		expect((await rateLimited(post(form), '/upload', form, limiters))?.status).toBe(429);
		expect([auth.keys.length, upload.keys.length]).toEqual([1, 1]);
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
