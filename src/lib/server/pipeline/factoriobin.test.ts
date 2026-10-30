import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { parsePostLink } from '#lib/factoriobin-link.js';
import { fixtureRecord } from '#lib/server/fixtures.js';
import { addRecord, knownSource } from './add-record';
import { admitRecord } from './admit';
import { d1FromSqlite } from './d1-sqlite';
import { addFactoriobinPost, parseInfo, readPost, toSourceRecord, type Fetcher } from './factoriobin';
import { pipelineLayer } from './layers';
import { ingestRecord } from './pipeline';
import { fromFactorioprints, fromPipelineText, rawKeyFor } from './source-record';

/** factoriobin's add path end to end on the real migrations and the real gate; posts are made up, strings are mirror fixtures. */

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const FP_ID = '-KYpTULTDIvDOsJfgjeS';
const FP_TEXT = await fixtureRecord(FP_ID);
const STRING = (JSON.parse(FP_TEXT) as { blueprintString: string }).blueprintString;
const BOOK = (JSON.parse(await fixtureRecord('-KnQ865j-qQ21WoUPbd3')) as { blueprintString: string }).blueprintString;

/** info.json in factoriobin's shape (seen 2026-10-30), for post `id`. */
const info = (id: string, over: { post?: Record<string, unknown>; node?: Record<string, unknown> } = {}) => ({
	post: { id, title: 'Bot based green circuits', createdAt: '2023-11-30T22:54:41.243Z', expiresAt: null, postedBy: null, ...over.post },
	node: {
		index: 0,
		parentIndex: null,
		type: 'blueprint',
		name: 'Green circuits',
		description: '3696 / min\n\nsee https://factorioprints.com/view/-KYpTULTDIvDOsJfgjeS',
		blueprintStringUrl: `https://cdn.factoriobin.com/perma/bp/x/y/${id}-abc/fbin-${id}-0.txt`,
		blueprintStringLength: STRING.length,
		renderImageUrl: `https://cdn.factoriobin.com/perma/bp/x/y/${id}-abc/fbin-${id}-0.jpg`,
		factorioVersion: '1.1.94',
		requiresSpaceAge: false,
		numEntities: 86,
		numTiles: 0,
		...over.node
	}
});

/** A fake factoriobin: info.json and the string per post id, counting requests. */
const site = (posts: Record<string, { info: unknown; string?: string }>) => {
	const requests: string[] = [];
	const fetcher: Fetcher = async (url, init) => {
		requests.push(url);
		expect(new Headers(init.headers).get('user-agent')).toContain('BlueprintAtlas');
		const m = /^https:\/\/factoriobin\.com\/post\/(\w+)\/info\.json$/.exec(url);
		if (m) return posts[m[1]] ? Response.json(posts[m[1]].info) : new Response('not found', { status: 404 });
		const s = /fbin-(\w+)-0\.txt$/.exec(url);
		if (s && posts[s[1]]?.string !== undefined) return new Response(posts[s[1]].string);
		return new Response('not found', { status: 404 });
	};
	return { fetcher, requests };
};

const bucket = () => {
	const objects = new Map<string, string>();
	return Object.assign(
		{
			get: async (k: string) =>
				objects.has(k) ? { text: async () => objects.get(k)!, json: async () => JSON.parse(objects.get(k)!) } : null,
			head: async (k: string) => (objects.has(k) ? {} : null),
			put: async (k: string, v: string) => void objects.set(k, v),
			delete: async (keys: string | string[]) => {
				for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
			},
			list: async () => ({ objects: [], truncated: false })
		} as unknown as R2Bucket,
		{ objects }
	);
};

const setup = () => {
	const sqlite = new Database(':memory:');
	for (const f of readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.sort())
		sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
	const DB = d1FromSqlite(sqlite);
	const RAW = bucket();
	const env = { DB, RAW, MIRROR_BASE_URL: 'https://mirror.test', FIREBASE_BASE_URL: 'https://firebase.test' } as unknown as Env;
	const one = <T>(sql: string, ...args: (string | number)[]) => sqlite.query(sql).get(...args) as T | null;
	return { sqlite, DB, RAW, env, one, b: { DB, RAW } };
};

/** factorioprints' fixture as a live print, as the backfill would ingest it. */
const ingestFactorioprints = async (s: ReturnType<typeof setup>) => {
	const record = fromFactorioprints(FP_ID, FP_TEXT);
	const admitted = await admitRecord(s.DB, record);
	if (admitted.status !== 'new') throw new Error(admitted.status);
	await Effect.runPromise(Effect.provide(ingestRecord(record, { ...admitted, printId: FP_ID }), pipelineLayer(s.env)));
};

describe('parsePostLink', () => {
	test('reads post links, book page links and bare ids', () => {
		expect(parsePostLink('https://factoriobin.com/post/LYMz5ZJT')).toEqual({ id: 'LYMz5ZJT', node: null });
		expect(parsePostLink(' factoriobin.com/post/1o4z16/2 ')).toEqual({ id: '1o4z16', node: 2 });
		expect(parsePostLink('https://www.factoriobin.com/post/9kis2r/info.json')).toEqual({ id: '9kis2r', node: null });
		expect(parsePostLink('https://factoriobin.com/post/9kis2r/?ref=reddit#x')).toEqual({ id: '9kis2r', node: null });
		expect(parsePostLink('LYMz5ZJT')).toEqual({ id: 'LYMz5ZJT', node: null });
	});
	test('refuses anything else', () => {
		for (const bad of [
			'',
			'https://factoriobin.com/',
			'https://factoriobin.com/about',
			'https://evil.example/post/LYMz5ZJT',
			'https://factoriobin.com.evil.example/post/LYMz5ZJT',
			'https://factoriobin.com/post/../../x',
			'ftp://factoriobin.com/post/LYMz5ZJT',
			'javascript:alert(1)',
			'LYM-z5ZJT'
		])
			expect(parsePostLink(bad)).toBeNull();
	});
});

describe('reading a post', () => {
	test('info.json becomes the record: title, in-game description, no author when anonymous, no image', () => {
		const r = toSourceRecord(parseInfo('LYMz5ZJT', info('LYMz5ZJT')), STRING);
		expect(r).toMatchObject({
			site: 'factoriobin',
			siteId: 'LYMz5ZJT',
			url: 'https://factoriobin.com/post/LYMz5ZJT',
			title: 'Bot based green circuits',
			description: '3696 / min\n\nsee https://factorioprints.com/view/-KYpTULTDIvDOsJfgjeS',
			author: null,
			image: null,
			uploadedAt: Date.parse('2023-11-30T22:54:41.243Z'),
			favorites: null,
			sourceHints: ['https://factorioprints.com/view/-KYpTULTDIvDOsJfgjeS']
		});
	});

	test('the blueprint label when the post has no title; the poster when named', () => {
		const r = toSourceRecord(
			parseInfo('abcdef', info('abcdef', { post: { title: null, postedBy: { username: 'Ada', hasCheckmark: true } } })),
			STRING
		);
		expect(r.title).toBe('Green circuits');
		expect(r.author).toEqual({ site: 'factoriobin', id: 'Ada', name: 'Ada' });
	});

	test('refuses an info.json for another post, a child node, or a string off its CDN', () => {
		expect(() => parseInfo('abcdef', info('zzzzzz'))).toThrow('not abcdef');
		expect(() => parseInfo('abcdef', info('abcdef', { node: { index: 2, parentIndex: 0 } }))).toThrow('root node');
		expect(() => parseInfo('abcdef', info('abcdef', { node: { blueprintStringUrl: 'https://evil.example/x.txt' } }))).toThrow('CDN');
	});

	test('one request per file; none for the string when info.json says it is over the cap', async () => {
		const { fetcher, requests } = site({ abcdef: { info: info('abcdef'), string: STRING } });
		expect(await readPost('abcdef', { fetch: fetcher })).toMatchObject({ ok: true, record: { blueprintString: STRING } });
		expect(requests.length).toBe(2);
		requests.length = 0;
		expect(await readPost('abcdef', { fetch: fetcher, maxStringBytes: 100 })).toMatchObject({
			ok: true,
			record: null,
			tooBig: { size: STRING.length, limit: 100 }
		});
		expect(requests).toEqual(['https://factoriobin.com/post/abcdef/info.json']);
	});

	test('a missing post, and one still processing', async () => {
		const { fetcher } = site({ proc12: { info: info('proc12', { node: { blueprintStringUrl: null } }) } });
		expect(await readPost('gone12', { fetch: fetcher })).toMatchObject({ ok: false, problem: 'not-found' });
		expect(await readPost('proc12', { fetch: fetcher })).toMatchObject({ ok: false, problem: 'processing' });
	});

	// The posts read while building this (2026-10-30), when their responses are in .cache/factoriobin.
	const CACHED = join(ROOT, '.cache', 'factoriobin');
	for (const id of ['LYMz5ZJT', '9kis2r', '1o4z16']) {
		if (!existsSync(join(CACHED, `${id}.info.json`))) continue;
		test(`real post ${id} reads as a record`, () => {
			const parsed = parseInfo(id, JSON.parse(readFileSync(join(CACHED, `${id}.info.json`), 'utf8')));
			expect(parsed.stringUrl?.startsWith('https://cdn.factoriobin.com/')).toBe(true);
			expect(Boolean(toSourceRecord(parsed, 'x').title)).toBe(true);
		});
	}
});

describe('adding through the gate', () => {
	test('a new post becomes fbin-<id>: analysed, archived, its source credited, the page cache bumped', async () => {
		const s = setup();
		const { fetcher } = site({ LYMz5ZJT: { info: info('LYMz5ZJT'), string: STRING } });
		const planned = await addFactoriobinPost(s.b, 'https://factoriobin.com/post/LYMz5ZJT/0', { fetch: fetcher, plan: true });
		expect(planned).toMatchObject({
			ok: true,
			post: { id: 'LYMz5ZJT', linkedNode: 0 },
			result: { status: 'new', printId: 'fbin-LYMz5ZJT', planned: true }
		});
		expect(s.one('SELECT 1 AS hit FROM prints')).toBeNull();

		const r = await addFactoriobinPost(s.b, 'https://factoriobin.com/post/LYMz5ZJT', { fetch: fetcher, now: 1234 });
		expect(r).toMatchObject({ ok: true, result: { status: 'new', printId: 'fbin-LYMz5ZJT', planned: false } });
		expect(s.one('SELECT title, source, source_url FROM prints WHERE id = ?', 'fbin-LYMz5ZJT')).toEqual({
			title: 'Bot based green circuits',
			source: 'factoriobin',
			source_url: 'https://factoriobin.com/post/LYMz5ZJT'
		});
		expect(s.one('SELECT site, site_id FROM print_sources WHERE print_id = ?', 'fbin-LYMz5ZJT')).toEqual({
			site: 'factoriobin',
			site_id: 'LYMz5ZJT'
		});
		expect(s.one(`SELECT value FROM meta WHERE key = 'sync_version'`)).toEqual({ value: '1234' });
		const archived = fromPipelineText(s.RAW.objects.get(rawKeyFor('factoriobin', 'LYMz5ZJT'))!);
		expect(archived).toMatchObject({ site: 'factoriobin', siteId: 'LYMz5ZJT', blueprintString: STRING, image: null });

		// Again: already here, nothing written.
		expect(await addFactoriobinPost(s.b, 'LYMz5ZJT', { fetch: fetcher })).toMatchObject({
			ok: true,
			result: { status: 'already', printId: 'fbin-LYMz5ZJT' }
		});
	});

	test('"Recently updated" order: a post has no updated date, so its posted date; with neither, when first admitted, kept on re-ingest', async () => {
		const s = setup();
		const { fetcher } = site({
			LYMz5ZJT: { info: info('LYMz5ZJT'), string: STRING },
			NoDate12: { info: info('NoDate12', { post: { createdAt: null } }), string: BOOK }
		});
		await addFactoriobinPost(s.b, 'LYMz5ZJT', { fetch: fetcher });
		const posted = Date.parse('2023-11-30T22:54:41.243Z');
		expect(s.one('SELECT created_at, updated_at FROM prints WHERE id = ?', 'fbin-LYMz5ZJT')).toEqual({
			created_at: posted,
			updated_at: posted
		});
		// The document keeps the record's own dates: the About tab shows no "Updated" line for it.
		const doc = JSON.parse(s.RAW.objects.get('analysis/fbin-LYMz5ZJT.json')!) as { print: { updated_at: number | null } };
		expect(doc.print.updated_at).toBeNull();

		const before = Date.now();
		await addFactoriobinPost(s.b, 'NoDate12', { fetch: fetcher });
		const first = s.one<{ created_at: number | null; updated_at: number }>(
			'SELECT created_at, updated_at FROM prints WHERE id = ?',
			'fbin-NoDate12'
		)!;
		expect(first.created_at).toBeNull();
		expect(first.updated_at >= before && first.updated_at <= Date.now()).toBe(true);
		// Re-ingested (a re-index, a re-analysis): it keeps its place rather than jumping to the top again.
		s.sqlite.run(`UPDATE prints SET updated_at = 5 WHERE id = 'fbin-NoDate12'`);
		const record = toSourceRecord(parseInfo('NoDate12', info('NoDate12', { post: { createdAt: null } })), BOOK);
		const admitted = await admitRecord(s.DB, record);
		if (admitted.status !== 'existing') throw new Error(admitted.status);
		await Effect.runPromise(Effect.provide(ingestRecord(record, admitted, { force: true }), pipelineLayer(s.env)));
		expect(s.one('SELECT updated_at FROM prints WHERE id = ?', 'fbin-NoDate12')).toEqual({ updated_at: 5 });
	});

	test('a copy of a factorioprints print joins it as another source, archived, not shown when posted later', async () => {
		const s = setup();
		await ingestFactorioprints(s);
		const { fetcher } = site({ copy1234: { info: info('copy1234', { post: { createdAt: '2025-01-01T00:00:00Z' } }), string: STRING } });
		expect(await addFactoriobinPost(s.b, 'copy1234', { fetch: fetcher, plan: true })).toMatchObject({
			result: { status: 'joins', printId: FP_ID, shown: null, planned: true }
		});
		expect(await addFactoriobinPost(s.b, 'copy1234', { fetch: fetcher })).toMatchObject({
			result: { status: 'joins', printId: FP_ID, shown: false, planned: false }
		});
		expect(s.one('SELECT 1 AS hit FROM prints WHERE id = ?', 'fbin-copy1234')).toBeNull();
		expect(s.one('SELECT print_id FROM print_sources WHERE site = ? AND site_id = ?', 'factoriobin', 'copy1234')).toEqual({
			print_id: FP_ID
		});
		expect(s.one('SELECT source FROM prints WHERE id = ?', FP_ID)).toEqual({ source: 'factorioprints' });
		expect(s.RAW.objects.has(rawKeyFor('factoriobin', 'copy1234'))).toBe(true);
		expect(await addFactoriobinPost(s.b, 'copy1234', { fetch: fetcher })).toMatchObject({ result: { status: 'already', printId: FP_ID } });
	});

	test('a post older than the print it copies is shown there (first upload wins), at the same URL', async () => {
		const s = setup();
		await ingestFactorioprints(s);
		const { fetcher } = site({ old12345: { info: info('old12345', { post: { createdAt: '2010-01-01T00:00:00Z' } }), string: STRING } });
		expect(await addFactoriobinPost(s.b, 'old12345', { fetch: fetcher })).toMatchObject({
			result: { status: 'joins', printId: FP_ID, shown: true }
		});
		expect(s.one('SELECT source FROM prints WHERE id = ?', FP_ID)).toEqual({ source: 'factoriobin' });
	});

	test('a blocked post is refused, by its source or by its content', async () => {
		const s = setup();
		s.sqlite.run(
			`INSERT INTO removal_blocks (kind, value, print_id, created_at) VALUES ('source', 'factoriobin:blocked1', 'fbin-blocked1', 1)`
		);
		const { fetcher } = site({ blocked1: { info: info('blocked1'), string: STRING }, again123: { info: info('again123'), string: BOOK } });
		expect(await addFactoriobinPost(s.b, 'blocked1', { fetch: fetcher })).toMatchObject({ result: { status: 'blocked', by: 'source' } });
		// Over the cap, a blocked source still says blocked, not too big.
		expect(
			await addFactoriobinPost(s.b, 'blocked1', { fetch: fetcher, limits: { maxStringBytes: 10, maxEntitiesAndTiles: 10 } })
		).toMatchObject({
			result: { status: 'blocked', by: 'source' }
		});
		const admitted = await admitRecord(s.DB, toSourceRecord(parseInfo('again123', info('again123')), BOOK));
		if (admitted.status !== 'new') throw new Error(admitted.status);
		const hash = admitted.admitted.fingerprint.whole!.exact;
		s.sqlite.run(`INSERT INTO removal_blocks (kind, value, print_id, created_at) VALUES ('sha256', '${hash}', 'x', 1)`);
		expect(await addFactoriobinPost(s.b, 'again123', { fetch: fetcher })).toMatchObject({ result: { status: 'blocked', by: 'sha256' } });
		expect(s.one('SELECT 1 AS hit FROM prints')).toBeNull();
	});

	test('over the Worker caps: too big, unless already here', async () => {
		const s = setup();
		const { fetcher } = site({ big12345: { info: info('big12345'), string: BOOK } });
		const limits = { maxStringBytes: 512 * 1024, maxEntitiesAndTiles: 10 };
		expect(await addFactoriobinPost(s.b, 'big12345', { fetch: fetcher, limits })).toMatchObject({
			result: { status: 'too-big', by: 'entities', limit: 10 }
		});
		await addFactoriobinPost(s.b, 'big12345', { fetch: fetcher });
		expect(await addFactoriobinPost(s.b, 'big12345', { fetch: fetcher, limits })).toMatchObject({
			result: { status: 'already', printId: 'fbin-big12345' }
		});
		expect(await knownSource(s.DB, 'factoriobin', 'nothere1')).toBeNull();
	});

	test('an unreadable string is refused and leaves no print', async () => {
		const s = setup();
		const { fetcher } = site({ bad12345: { info: info('bad12345'), string: '0eNotAString' } });
		expect(await addFactoriobinPost(s.b, 'bad12345', { fetch: fetcher })).toMatchObject({ result: { status: 'unreadable' } });
		expect(s.one('SELECT 1 AS hit FROM prints')).toBeNull();
	});

	test('a bad link or a missing post is an answer, not a throw', async () => {
		const s = setup();
		const { fetcher, requests } = site({});
		expect(await addFactoriobinPost(s.b, 'https://example.com/post/abc', { fetch: fetcher })).toMatchObject({
			ok: false,
			problem: 'bad-link'
		});
		expect(requests.length).toBe(0);
		expect(await addFactoriobinPost(s.b, 'nothere1', { fetch: fetcher })).toMatchObject({ ok: false, problem: 'not-found' });
	});

	test('addRecord answers failed, not a throw, when storage fails', async () => {
		const s = setup();
		const broken = { ...s.b, RAW: { ...s.RAW, put: async () => Promise.reject(new Error('R2 down')) } as unknown as R2Bucket };
		const r = await addRecord(broken, toSourceRecord(parseInfo('fail1234', info('fail1234')), STRING));
		expect(r.status).toBe('failed');
	});
});
