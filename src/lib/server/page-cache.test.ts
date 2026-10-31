import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	BROWSER_KEEPS,
	bumpPageVersion,
	cachedPage,
	cacheTtl,
	dataVersion,
	forgetDataVersion,
	pageCacheKey,
	storable,
	VERSION_TTL_MS,
	type PageCacheDeps
} from './page-cache.js';
import { d1FromSqlite } from './pipeline/d1-sqlite.js';

const freshDb = () => {
	const sqlite = new Database(':memory:');
	sqlite.run('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
	return { sqlite, db: d1FromSqlite(sqlite) };
};

/** A Cache over a Map, as `caches.default` behaves for these calls (keyed by URL). */
const memoryCache = () => {
	const entries = new Map<string, { body: string; init: ResponseInit & { headers: [string, string][] } }>();
	const cache = {
		match: async (key: Request) => {
			const e = entries.get(key.url);
			return e ? new Response(e.body, e.init) : undefined;
		},
		put: async (key: Request, res: Response) => {
			entries.set(key.url, { body: await res.text(), init: { status: res.status, headers: [...res.headers] } });
		}
	};
	return { cache, entries };
};

const setup = () => {
	forgetDataVersion();
	const { sqlite, db } = freshDb();
	const { cache, entries } = memoryCache();
	const pending: Promise<unknown>[] = [];
	let renders = 0;
	const deps: PageCacheDeps = { cache, db, build: 'b1', waitUntil: (p) => void pending.push(p) };
	const page =
		(body = 'page', init: ResponseInit = {}) =>
		async () => {
			renders++;
			return new Response(body, {
				status: 200,
				headers: { 'content-type': 'text/html', 'content-security-policy': "script-src 'nonce-abc'" },
				...init
			});
		};
	const get = async (url: string, render = page(), d = deps, ttl = 3600, browserKeeps = false) => {
		const res = await cachedPage(new Request(url), ttl, render, d, browserKeeps);
		await Promise.all(pending.splice(0));
		return res;
	};
	return { sqlite, db, entries, deps, page, get, renders: () => renders };
};

describe('what is cached', () => {
	test('GETs of the search, print and full-screen render routes, with their own lifetimes', () => {
		expect(cacheTtl('GET', '/')).toBe(3600);
		expect(cacheTtl('GET', '/prints/[id]')).toBe(86_400);
		expect(cacheTtl('GET', '/prints/[id]/render')).toBe(86_400);
		// The JSON the pages fetch, as long as browsers already kept it.
		expect(cacheTtl('GET', '/prints/[id]/viewer')).toBe(300);
		expect(cacheTtl('GET', '/quality-levels')).toBe(300);
		expect([...BROWSER_KEEPS].sort()).toEqual(['/prints/[id]/viewer', '/quality-levels']);
		for (const [method, route] of [
			['POST', '/'],
			['HEAD', '/'],
			['GET', '/prints/[id]/view'],
			['GET', '/prints/[id]/string'],
			['GET', '/admin/pipeline'],
			['GET', '/sitemap.xml'],
			// Per account: they read the session, which cached routes can't (lib/server/auth/locals.ts).
			['GET', '/me'],
			['GET', '/account'],
			['GET', '/login'],
			['GET', '/upload'],
			['GET', '/uploads/[id]'],
			['GET', '/auth/[provider]/callback'],
			['GET', null]
		] as const)
			expect(cacheTtl(method, route)).toBeNull();
	});

	test('only 200s without Set-Cookie, no-store or private', () => {
		expect(storable(new Response('x'))).toBe(true);
		expect(storable(new Response('x', { status: 404 }))).toBe(false);
		expect(storable(new Response('x', { status: 429 }))).toBe(false);
		expect(storable(new Response('x', { headers: { 'set-cookie': 'a=1' } }))).toBe(false);
		expect(storable(new Response('x', { headers: { 'cache-control': 'no-store' } }))).toBe(false);
		expect(storable(new Response('x', { headers: { 'cache-control': 'private, max-age=60' } }))).toBe(false);
		// SvelteKit's default for __data.json, which the cached routes don't need.
		expect(storable(new Response('{}', { headers: { 'cache-control': 'private, no-store' } }), true)).toBe(true);
		expect(storable(new Response('{}', { status: 500, headers: { 'cache-control': 'private, no-store' } }), true)).toBe(false);
	});

	test('the key keeps path and query (HTML and __data.json apart) under both versions', () => {
		expect(pageCacheKey('https://example.com/?makes=item%3Arail&p=2', 'b1', '17').url).toBe(
			'https://example.com/__page-cache/b1/17/?makes=item%3Arail&p=2'
		);
		expect(pageCacheKey('https://example.com/prints/abc/__data.json?x-sveltekit-invalidated=01', 'b1', '17').url).toBe(
			'https://example.com/__page-cache/b1/17/prints/abc/__data.json?x-sveltekit-invalidated=01'
		);
	});
});

describe('cachedPage', () => {
	beforeEach(() => forgetDataVersion());

	test('a miss renders and stores; the next request is a hit with the same body and headers', async () => {
		const s = setup();
		const first = await s.get('https://example.com/?q=belt');
		expect([first.headers.get('x-page-cache'), first.headers.get('cache-control'), await first.text()]).toEqual([
			'miss',
			'no-cache',
			'page'
		]);
		const second = await s.get('https://example.com/?q=belt', s.page('different'));
		expect([second.headers.get('x-page-cache'), second.headers.get('cache-control'), await second.text()]).toEqual([
			'hit',
			'no-cache',
			'page'
		]);
		// The page's CSP (and nonce) travel with it.
		expect(second.headers.get('content-security-policy')).toBe("script-src 'nonce-abc'");
		expect(s.renders()).toBe(1);
		// The stored copy is fresh for the route's lifetime; browsers never keep it.
		expect(new Headers([...s.entries.values()][0].init.headers).get('cache-control')).toBe('public, max-age=3600');
	});

	test('another query, or the __data.json of the same page, is its own entry', async () => {
		const s = setup();
		await s.get('https://example.com/?q=belt');
		expect((await s.get('https://example.com/?q=belts')).headers.get('x-page-cache')).toBe('miss');
		expect((await s.get('https://example.com/__data.json?q=belt')).headers.get('x-page-cache')).toBe('miss');
		expect(s.renders()).toBe(3);
	});

	test('errors and cookies are passed through, never stored', async () => {
		const s = setup();
		for (const init of [{ status: 404 }, { status: 500 }, { headers: { 'set-cookie': 'a=1' } }] as ResponseInit[]) {
			const res = await s.get('https://example.com/prints/x', s.page('err', init));
			expect(res.headers.get('x-page-cache')).toBeNull();
		}
		expect(s.entries.size).toBe(0);
	});

	test('a new data version (bumpPageVersion) purges everything, once the remembered version expires', async () => {
		const s = setup();
		await s.get('https://example.com/');
		await bumpPageVersion(s.db, 123).run();
		// Within VERSION_TTL_MS the isolate still uses the version it read.
		expect((await s.get('https://example.com/')).headers.get('x-page-cache')).toBe('hit');
		forgetDataVersion();
		const after = await s.get('https://example.com/', s.page('new'));
		expect([after.headers.get('x-page-cache'), await after.text()]).toEqual(['miss', 'new']);
	});

	test('a new build (a deploy) purges everything', async () => {
		const s = setup();
		await s.get('https://example.com/');
		const res = await s.get('https://example.com/', s.page('new'), { ...s.deps, build: 'b2' });
		expect([res.headers.get('x-page-cache'), await res.text()]).toEqual(['miss', 'new']);
	});

	test('if the cache or D1 fails, the page is rendered anyway', async () => {
		const s = setup();
		const broken = { ...s.deps, cache: { match: async () => Promise.reject(new Error('boom')), put: async () => {} } };
		const res = await s.get('https://example.com/', s.page('ok'), broken);
		expect(await res.text()).toBe('ok');
		const putFails = { ...s.deps, cache: { match: async () => undefined, put: async () => Promise.reject(new Error('full')) } };
		expect(await (await s.get('https://example.com/', s.page('ok2'), putFails)).text()).toBe('ok2');
	});
});

describe('endpoints browsers keep (BROWSER_KEEPS)', () => {
	const json = (s: ReturnType<typeof setup>) =>
		s.page('{"n":1}', {
			headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300', 'x-robots-tag': 'noindex' }
		});

	test('stored for the route lifetime; the browser keeps `public, max-age=300` on a miss and a hit', async () => {
		const s = setup();
		const url = 'https://example.com/prints/abc/viewer?page=3';
		const miss = await s.get(url, json(s), s.deps, 300, true);
		expect(miss.headers.get('x-page-cache')).toBe('miss');
		expect(miss.headers.get('cache-control')).toBe('public, max-age=300');
		expect(await miss.text()).toBe('{"n":1}');
		expect(new Headers([...s.entries.values()][0].init.headers).get('cache-control')).toBe('public, max-age=300');
		const hit = await s.get(url, json(s), s.deps, 300, true);
		expect(hit.headers.get('x-page-cache')).toBe('hit');
		expect(hit.headers.get('cache-control')).toBe('public, max-age=300');
		expect(hit.headers.get('x-robots-tag')).toBe('noindex');
		expect(await hit.text()).toBe('{"n":1}');
		expect(s.renders()).toBe(1);
	});

	test('another page or search is its own entry; a 400 or 404 is never stored', async () => {
		const s = setup();
		await s.get('https://example.com/quality-levels?uses=entity:beacon&filter=uses&value=entity:beacon', json(s), s.deps, 300, true);
		await s.get('https://example.com/quality-levels?uses=entity:lab&filter=uses&value=entity:lab', json(s), s.deps, 300, true);
		expect(s.entries.size).toBe(2);
		const bad = await s.get('https://example.com/quality-levels?filter=uses', s.page('no', { status: 400 }), s.deps, 300, true);
		expect(bad.headers.get('x-page-cache')).toBeNull();
		expect(s.entries.size).toBe(2);
	});

	test('pages still tell the browser no-cache', async () => {
		const s = setup();
		expect((await s.get('https://example.com/prints/abc')).headers.get('cache-control')).toBe('no-cache');
		expect((await s.get('https://example.com/prints/abc')).headers.get('cache-control')).toBe('no-cache');
	});
});

describe('dataVersion', () => {
	test("meta.sync_version, '0' before the first bump, read at most once per VERSION_TTL_MS", async () => {
		forgetDataVersion();
		const { db } = freshDb();
		expect(await dataVersion(db, 1000)).toBe('0');
		await bumpPageVersion(db, 42).run();
		expect(await dataVersion(db, 1000 + VERSION_TTL_MS - 1)).toBe('0');
		expect(await dataVersion(db, 1000 + VERSION_TTL_MS)).toBe('42');
	});
});
