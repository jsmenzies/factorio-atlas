import { describe, expect, test } from 'bun:test';
import { fetchViews, isBot, parseViews, planViews, recordView, viewsQuery, type ViewDataset } from './views.js';

const ID = '-KnQ865j-qQ21WoUPbd3';
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0';

const dataset = () => {
	const points: unknown[] = [];
	return { points, ds: { writeDataPoint: (p) => void points.push(p) } satisfies ViewDataset };
};

describe('recordView', () => {
	test('writes one data point with only the print id', () => {
		const { points, ds } = dataset();
		expect(recordView(ds, ID, FIREFOX)).toBe(true);
		expect(points).toEqual([{ indexes: [ID] }]);
	});

	test('skips bots, missing user agents, malformed ids and a missing binding', () => {
		const { points, ds } = dataset();
		expect(recordView(ds, ID, 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(false);
		expect(recordView(ds, ID, null)).toBe(false);
		expect(recordView(ds, 'not-an-id', FIREFOX)).toBe(false);
		expect(recordView(ds, `${ID}x`, FIREFOX)).toBe(false);
		expect(recordView(undefined, ID, FIREFOX)).toBe(false);
		expect(points).toEqual([]);
		expect(isBot('curl/8.5.0')).toBe(true);
		expect(isBot(FIREFOX)).toBe(false);
	});
});

describe('the Analytics Engine query', () => {
	test('names the dataset and the window, and refuses anything but a plain name', () => {
		const sql = viewsQuery('factorio_prints_prod_views', 10);
		expect(sql).toContain('FROM factorio_prints_prod_views');
		expect(sql).toContain("INTERVAL '30' DAY");
		expect(sql).toContain('SUM(_sample_interval)');
		expect(() => viewsQuery('x; DROP', 10)).toThrow();
	});

	test('parses counts given as strings or numbers, dropping junk ids and zeros', () => {
		const body = {
			data: [
				{ id: ID, views: '12' },
				{ id: 'AAAAAAAAAAAAAAAAAAAA', views: 3 },
				{ id: 'nope', views: 4 },
				{ id: 'BBBBBBBBBBBBBBBBBBBB', views: 0 }
			]
		};
		expect([...parseViews(body)]).toEqual([
			[ID, 12],
			['AAAAAAAAAAAAAAAAAAAA', 3]
		]);
		expect(() => parseViews({ errors: ['bad'] })).toThrow();
	});

	test('fetchViews posts the SQL with the token and reports API errors', async () => {
		let seen: { url: string; init?: RequestInit } | undefined;
		const ok = (async (url: string, init?: RequestInit) => {
			seen = { url, init };
			return new Response(JSON.stringify({ data: [{ id: ID, views: '2' }] }));
		}) as unknown as typeof fetch;
		const views = await fetchViews({ accountId: 'acct', token: 'tok', dataset: 'd', fetch: ok });
		expect([...views]).toEqual([[ID, 2]]);
		expect(seen?.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/analytics_engine/sql');
		expect(seen?.init?.headers).toEqual({ authorization: 'Bearer tok' });
		const denied = (async () => new Response('Authentication error', { status: 403 })) as unknown as typeof fetch;
		await expect(fetchViews({ accountId: 'acct', token: 'tok', dataset: 'd', fetch: denied })).rejects.toThrow('403');
	});
});

test('planViews sets changed counts and clears prints that fell out of the window', () => {
	const wanted = new Map([
		['b', 5],
		['a', 2],
		['c', 7]
	]);
	const current = new Map([
		['a', 2],
		['c', 1],
		['d', 9]
	]);
	expect(planViews(wanted, current)).toEqual({
		set: [
			['b', 5],
			['c', 7]
		],
		clear: ['d']
	});
	expect(planViews(current, current)).toEqual({ set: [], clear: [] });
});
