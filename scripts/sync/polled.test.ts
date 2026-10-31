import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceRecord } from '#lib/server/pipeline/source-record.js';
import { foldProgress, logProgress, SYNC_PROGRESS_ENV } from '#lib/sync-progress.js';
import {
	admissionWork,
	applyPoll,
	emptyState,
	PoliteHttp,
	planPoll,
	readState,
	type Fetched,
	type ListedPrint,
	type PolledSite,
	type PollState
} from './polled';

/** A site of `prints` (id → updatedAt), listed newest first, `per` a page; `missing` ids answer 404. */
const fakeSite = (
	prints: Map<string, number>,
	o: { per?: number; missing?: Set<string>; failing?: Set<string>; version?: { v: number } } = {}
) => {
	const per = o.per ?? 3;
	const calls: string[] = [];
	const site: PolledSite = {
		site: 'codex',
		async listPage(page, http) {
			http.lists++;
			calls.push(`list ${page}`);
			const all: ListedPrint[] = [...prints]
				.map(([siteId, t]) => ({ siteId, rev: `${t}#${o.version?.v ?? 1}`, updatedAt: t }))
				.sort((a, b) => b.updatedAt - a.updatedAt);
			return { items: all.slice((page - 1) * per, page * per), total: all.length, totalPages: Math.ceil(all.length / per) };
		},
		async fetchRecord(siteId, http): Promise<Fetched> {
			http.reads++;
			calls.push(`read ${siteId}`);
			if (o.failing?.has(siteId)) throw new Error('HTTP 500');
			if (o.missing?.has(siteId) || !prints.has(siteId)) return { gone: 'HTTP 404' };
			const record: SourceRecord = {
				site: 'codex',
				siteId,
				url: `https://example.com/${siteId}`,
				title: `print ${siteId}`,
				description: null,
				author: null,
				blueprintString: `0e${siteId}@${prints.get(siteId)}`,
				image: null,
				uploadedAt: 1,
				updatedAt: prints.get(siteId)!,
				favorites: null,
				sourceHints: []
			};
			return { record };
		}
	};
	return { site, calls };
};

const http = () => new PoliteHttp({ minIntervalMs: 0 });

let inbox: string;
beforeEach(async () => {
	inbox = await mkdtemp(join(tmpdir(), 'polled-'));
});
afterEach(async () => {
	await rm(inbox, { recursive: true, force: true });
});

const NOW = 10_000_000_000;

/**
 * Plan then apply, as the update's fetch step does; the state as saved. A first import is held back for Accept:
 * here it is let through as if accepted (`holdFirst` keeps it held), so the tests start from an imported site.
 */
const fetchOnce = async (
	site: PolledSite,
	o: { maxChange?: number; accept?: string; holdFirst?: boolean; stopAfter?: number; log?: (line: string) => void } = {}
) => {
	const maxChange = o.maxChange ?? 0.05;
	const state = await readState(inbox, 'codex');
	const first = Object.keys(state.records).length === 0;
	const h = http();
	const { plan, work } = await planPoll(site, state, h, { maxChange, accept: o.accept, now: NOW });
	const firstImport = first && !o.holdFirst && plan.blocked?.includes('a first import');
	if ((plan.blocked && !firstImport) || plan.from.id === plan.to.id) return { plan, counts: null, state };
	const counts = await applyPoll(site, inbox, state, work, h, {
		maxChange,
		now: () => NOW,
		stopping: o.stopAfter === undefined ? undefined : () => h.reads >= o.stopAfter!,
		log: o.log
	});
	return { plan, counts, state: await readState(inbox, 'codex') };
};
/** A site of `n` prints, 1…n, changed at 100…; listed `per` a page. */
const many = (n: number) => new Map([...Array(n)].map((_, i) => [String(i + 1), 100 + i] as [string, number]));

describe('polled sites: fetch', () => {
	test('each record read gives the Update tab the same live count as its log line did', async () => {
		const events = join(inbox, 'progress.jsonl');
		process.env[SYNC_PROGRESS_ENV] = events;
		try {
			const lines: string[] = [];
			const log = (line: string) => lines.push(line);
			const prints = many(7);
			const version = { v: 1 };
			const { site } = fakeSite(prints, { failing: new Set(['3']), version });
			await fetchOnce(site, { log }); // new, and one failed read
			prints.set('2', 300);
			prints.delete('5');
			version.v = 2;
			await fetchOnce(site, { log, maxChange: 1 }); // changed, same text, gone, failed again
			const text = await readFile(events, 'utf8');
			const fromLog = logProgress(`== Fetch new prints\n${lines.join('\n')}\n`);
			expect(new Set(Object.keys(fromLog.sites.codex))).toEqual(new Set(['new', 'failed', 'changed', 'same', 'gone']));
			expect(foldProgress(`{"t":"step","step":"fetch"}\n${text}`)).toEqual(fromLog);
		} finally {
			delete process.env[SYNC_PROGRESS_ENV];
		}
	});

	test('the first fetch lists every page and reads every print, oldest change first', async () => {
		const prints = new Map([...Array(7)].map((_, i) => [String(i + 1), 100 + i] as [string, number]));
		const { site, calls } = fakeSite(prints);
		const { plan, counts, state } = await fetchOnce(site);
		expect(plan).toMatchObject({ polled: true, added: 7, edited: 0, prints: 7 });
		expect(plan.blocked).toBe('7 new, 0 removed: a first import; check the site, then accept it to import them');
		expect(calls.filter((c) => c.startsWith('list'))).toEqual(['list 1', 'list 2', 'list 3']);
		expect(calls.filter((c) => c.startsWith('read'))).toEqual(['1', '2', '3', '4', '5', '6', '7'].map((i) => `read ${i}`));
		expect(counts).toMatchObject({ new: 7, reads: 7, left: 0 });
		expect(state).toMatchObject({ cursor: 106, total: 7, fullAt: NOW });
		expect(JSON.parse(await readFile(join(inbox, 'codex', '3.json'), 'utf8'))).toMatchObject({ site: 'codex', siteId: '3' });
	});

	test('later fetches list only until the cursor and read only what changed', async () => {
		const prints = new Map([...Array(7)].map((_, i) => [String(i + 1), 100 + i] as [string, number]));
		const { site, calls } = fakeSite(prints);
		await fetchOnce(site);
		calls.length = 0;
		const quiet = await fetchOnce(site);
		expect(quiet.plan.from.id).toBe(quiet.plan.to.id);
		expect(calls).toEqual(['list 1']);
		calls.length = 0;
		prints.set('2', 200);
		prints.set('8', 201);
		const { plan, counts } = await fetchOnce(site);
		expect(plan).toMatchObject({ added: 1, edited: 1, deleted: [] });
		expect(calls).toEqual(['list 1', 'read 2', 'read 8']);
		expect(counts).toMatchObject({ new: 1, changed: 1, rewritten: 1 });
	});

	test('a new record version (same change times, new revisions) reads every print again', async () => {
		const prints = new Map([...Array(7)].map((_, i) => [String(i + 1), 100 + i] as [string, number]));
		const version = { v: 1 };
		const { site, calls } = fakeSite(prints, { version });
		await fetchOnce(site);
		version.v = 2;
		site.version = 2;
		calls.length = 0;
		const { plan, counts } = await fetchOnce(site);
		expect(plan).toMatchObject({ added: 0, edited: 7 });
		expect(calls.filter((c) => c.startsWith('list'))).toEqual(['list 1', 'list 2', 'list 3']);
		expect(counts).toMatchObject({ changed: 7 });
	});

	test('no read cap: every new and changed record is read; a stop leaves the rest pending, read first next time', async () => {
		const prints = many(5);
		const { site, calls } = fakeSite(prints);
		const first = await fetchOnce(site, { stopAfter: 2 });
		expect(first.counts).toMatchObject({ new: 2, left: 3 });
		expect(Object.keys(first.state.pending).sort()).toEqual(['3', '4', '5']);
		calls.length = 0;
		const second = await fetchOnce(site);
		expect(second.counts).toMatchObject({ new: 3, left: 0 });
		expect(calls).toEqual(['list 1', 'read 3', 'read 4', 'read 5']);
		// 1,200 changed at once, more than the old cap of 1,000: all read in one update.
		const big = many(1200);
		const b = fakeSite(big, { per: 400 });
		await rm(join(inbox, 'codex'), { recursive: true, force: true });
		await fetchOnce(b.site);
		for (const [id, t] of big) big.set(id, t + 10_000);
		expect((await fetchOnce(b.site)).counts).toMatchObject({ changed: 1200, left: 0 });
	});

	test('prints never read (every read failed last time) count as new, not changed, listed on page 1 or not', async () => {
		// As codex on 2026-10-30: a fetch whose reads all failed (HTTP 522) left every print pending with the
		// cursor moved on, so the next plan listed one page and called the other pending prints "changed".
		const prints = new Map([...Array(7)].map((_, i) => [String(i + 1), 100 + i] as [string, number]));
		const failing = new Set(prints.keys());
		const { site, calls } = fakeSite(prints, { failing });
		const first = await fetchOnce(site);
		expect(first.counts).toMatchObject({ new: 0, failed: 7 });
		expect(Object.keys(first.state.pending).length).toBe(7);
		failing.clear();
		calls.length = 0;
		const { plan, counts } = await fetchOnce(site);
		expect(calls.filter((c) => c.startsWith('list'))).toEqual(['list 1']);
		expect(plan).toMatchObject({ added: 7, edited: 0, stateText: '7 new' });
		expect(counts).toMatchObject({ new: 7, changed: 0, left: 0 });
		// A print read before and changed since still counts as changed.
		prints.set('3', 300);
		expect((await fetchOnce(site)).plan).toMatchObject({ added: 0, edited: 1, stateText: '1 changed' });
	});

	test('a failed read is pending and tried again', async () => {
		const prints = new Map([
			['1', 100],
			['2', 101]
		]);
		const failing = new Set(['1']);
		const { site } = fakeSite(prints, { failing });
		expect((await fetchOnce(site)).counts).toMatchObject({ new: 1, failed: 1 });
		failing.clear();
		expect((await fetchOnce(site)).counts).toMatchObject({ new: 1, failed: 0 });
	});

	test('a total lower than expected lists everything; a missing print is gone once its read says so', async () => {
		const prints = new Map([...Array(30)].map((_, i) => [String(i + 1), 100 + i] as [string, number]));
		const { site, calls } = fakeSite(prints, { per: 10 });
		await fetchOnce(site);
		prints.delete('4');
		calls.length = 0;
		const { plan, counts, state } = await fetchOnce(site);
		expect(plan.deleted).toEqual(['4']);
		expect(calls).toEqual(['list 1', 'list 2', 'list 3', 'read 4']);
		expect(counts).toMatchObject({ gone: 1 });
		expect(Object.keys(state.gone)).toEqual(['4']);
		expect(state.records['4']).toBeUndefined();
	});

	test('a listed print whose record answers 404 is a failed read, kept pending, never gone', async () => {
		const prints = new Map([...Array(7)].map((_, i) => [String(i + 1), 100 + i] as [string, number]));
		const missing = new Set<string>();
		const version = { v: 1 };
		const { site } = fakeSite(prints, { missing, version });
		await fetchOnce(site);
		prints.set('3', 300);
		missing.add('3');
		const one = await fetchOnce(site);
		expect(one.counts).toMatchObject({ gone: 0, failed: 1 });
		expect(one.state.records['3'] !== undefined).toBe(true);
		expect(one.state.pending['3']).toBe('300#1');
		// A record version bump while the detail endpoint answers 404 for everything: nothing is gone.
		for (const id of prints.keys()) missing.add(id);
		version.v = 2;
		site.version = 2;
		const all = await fetchOnce(site);
		expect(all.counts).toMatchObject({ gone: 0, failed: 7 });
		expect(Object.keys(all.state.records).length).toBe(7);
		expect(Object.keys(all.state.gone).length).toBe(0);
	});

	test('the reads find at most the hold-back limit of the known prints gone in one fetch, whatever the plan said', async () => {
		const prints = many(600);
		const { site } = fakeSite(prints, { per: 100 });
		await fetchOnce(site);
		for (let i = 1; i <= 40; i++) prints.delete(String(i));
		const state = await readState(inbox, 'codex');
		const h = http();
		const { work } = await planPoll(site, state, h, { maxChange: 1, now: NOW });
		expect(work.missing.length).toBe(40);
		// 5% of 600 is 30.
		const counts = await applyPoll(site, inbox, state, work, h, { maxChange: 0.05, now: () => NOW });
		expect(counts).toMatchObject({ gone: 30, goneHeld: 10 });
		expect(Object.keys((await readState(inbox, 'codex')).records).length).toBe(570);
	});

	describe('held back by the one rule: new + removed past max(maxChange × known, 25)', () => {
		test('the floor: a small site is not held back for normal activity', async () => {
			const prints = many(20);
			const { site } = fakeSite(prints, { per: 10 });
			await fetchOnce(site);
			for (const id of ['1', '2', '3']) prints.delete(id);
			for (let i = 21; i <= 30; i++) prints.set(String(i), 1000 + i);
			const r = await fetchOnce(site);
			expect(r.plan).toMatchObject({ added: 10, blocked: null });
			expect(r.counts).toMatchObject({ new: 10, gone: 3 });
		});

		test('removed only, then accepted', async () => {
			const prints = many(100);
			const { site } = fakeSite(prints, { per: 50 });
			await fetchOnce(site);
			for (let i = 1; i <= 26; i++) prints.delete(String(i));
			const held = await fetchOnce(site);
			expect(held.plan.blocked).toBe("0 new, 26 removed: more than 5% (25 at least) of 100; check the site, then accept it if it's right");
			expect(held.counts).toBeNull();
			const accepted = await fetchOnce(site, { accept: held.plan.to.id });
			expect(accepted.plan.blocked).toBeNull();
			expect(accepted.counts).toMatchObject({ gone: 26 });
		});

		test('new only; changed prints never count', async () => {
			const prints = many(100);
			const { site } = fakeSite(prints, { per: 50 });
			await fetchOnce(site);
			for (const [id, t] of prints) prints.set(id, t + 5000);
			const edited = await fetchOnce(site);
			expect(edited.plan).toMatchObject({ edited: 100, blocked: null });
			for (let i = 101; i <= 130; i++) prints.set(String(i), 9000 + i);
			expect((await fetchOnce(site)).plan.blocked).toContain('30 new, 0 removed: more than 5% (25 at least) of 100');
		});

		test('a first import is held back once; Accept lets it through', async () => {
			const { site } = fakeSite(many(3));
			const held = await fetchOnce(site, { holdFirst: true });
			expect(held.plan.blocked).toContain('3 new, 0 removed: a first import');
			const accepted = await fetchOnce(site, { holdFirst: true, accept: held.plan.to.id });
			expect(accepted.counts).toMatchObject({ new: 3 });
		});

		test('reads left pending passed an earlier plan: an accepted first import stopped part-way isn’t held again', async () => {
			const { site } = fakeSite(many(456), { per: 100 });
			const held = await fetchOnce(site, { holdFirst: true });
			expect(held.plan.blocked).toContain('456 new, 0 removed: a first import');
			const first = await fetchOnce(site, { holdFirst: true, accept: held.plan.to.id, stopAfter: 100 });
			expect(first.counts).toMatchObject({ new: 100, left: 356 });
			const next = await fetchOnce(site, { holdFirst: true });
			expect(next.plan).toMatchObject({ added: 356, blocked: null });
			expect(next.counts).toMatchObject({ new: 356, left: 0 });
		});

		test('an empty list while prints are known is a hard stop, whatever the share', async () => {
			const prints = many(20);
			const { site } = fakeSite(prints, { per: 10 });
			await fetchOnce(site);
			prints.clear();
			expect((await fetchOnce(site, { maxChange: 1 })).plan.blocked).toContain('lists no prints');
		});
	});
});

describe('polled sites: admission work', () => {
	test("records at a revision the stage wasn't given, and gone prints it had", () => {
		const state: PollState = {
			...emptyState(),
			records: { '1': { rev: 'a', firstSeen: 1, fetchedAt: 1 }, '2': { rev: 'b', firstSeen: 2, fetchedAt: 2 } },
			gone: { '3': 5, '4': 5 }
		};
		const ledger = { v: 1 as const, records: { '1': 'a', '3': 'x', '4': 'gone' } };
		expect(admissionWork(state, ledger)).toEqual({ records: ['2'], gone: ['3'] });
		expect(admissionWork(state, ledger, true).records).toEqual(['1', '2']);
		// A record whose print a failed hand-over purged goes through the gate again at the revision it was given.
		expect(admissionWork(state, ledger, false, ['1']).records).toEqual(['1', '2']);
	});
});

describe('PoliteHttp', () => {
	test('one request per interval, a User-Agent, retries on 429 and 5xx, 404 passed back', async () => {
		const seen: { url: string; ua: string | null }[] = [];
		const slept: number[] = [];
		const answers = [
			new Response('', { status: 503 }),
			new Response('', { status: 429, headers: { 'retry-after': '2' } }),
			Response.json({ ok: 1 })
		];
		const h = new PoliteHttp({
			minIntervalMs: 0,
			sleep: async (ms) => void slept.push(ms),
			fetch: (async (url: string, init: RequestInit) => {
				seen.push({ url, ua: new Headers(init.headers).get('user-agent') });
				return answers.shift() ?? new Response('', { status: 404 });
			}) as unknown as typeof fetch
		});
		expect(await h.get('https://example.com/a', 'list')).toEqual({ status: 200, body: { ok: 1 } });
		expect(slept).toEqual([5000, 2000]);
		expect(seen[0].ua).toContain('factorio-atlas');
		expect(await h.get('https://example.com/b', 'read')).toEqual({ status: 404, body: null });
		expect([h.lists, h.reads]).toEqual([3, 1]);
	});

	test('text bodies; a failure goneIf recognises is passed back at once, others still retried', async () => {
		const slept: number[] = [];
		const answers = [
			new Response('<urlset/>'),
			new Response('{"error":"no rows"}', { status: 500 }),
			new Response('{"error":"busy"}', { status: 500 }),
			new Response('{"error":"busy"}', { status: 500 }),
			new Response('{"error":"busy"}', { status: 500 })
		];
		const h = new PoliteHttp({
			minIntervalMs: 0,
			sleep: async (ms) => void slept.push(ms),
			fetch: (async () => answers.shift()!) as unknown as typeof fetch
		});
		expect(await h.get('https://example.com/sitemap.xml', 'list', undefined, { text: true })).toEqual({ status: 200, body: '<urlset/>' });
		const goneIf = (status: number, text: string) => status === 500 && text.includes('no rows');
		expect(await h.get('https://example.com/r?id=1', 'read', undefined, { goneIf })).toEqual({ status: 500, body: null });
		expect(slept).toEqual([]);
		await expect(h.get('https://example.com/r?id=2', 'read', undefined, { goneIf })).rejects.toThrow('HTTP 500');
		// goneIf sees the start of an error body, never a whole page.
		let seen = 0;
		const big = new PoliteHttp({
			minIntervalMs: 0,
			tries: 1,
			fetch: (async () => new Response('x'.repeat(1_000_000), { status: 500 })) as unknown as typeof fetch
		});
		await expect(
			big.get('https://example.com/r?id=3', 'read', undefined, { goneIf: (_s, t) => ((seen = t.length), false) })
		).rejects.toThrow('HTTP 500');
		expect(seen).toBe(4096);
	});

	test('a site whose one page lists everything has a full listing every time: a deletion is noticed at once', async () => {
		const prints = new Map([...Array(30)].map((_, i) => [String(i + 1), 100 + i] as [string, number]));
		const { site, calls } = fakeSite(prints, { per: 100 });
		site.listsAll = true;
		await fetchOnce(site);
		prints.delete('4');
		// Same total as known would hide it from a cursor listing; listsAll lists in full anyway.
		prints.set('31', 50);
		calls.length = 0;
		const { plan, counts } = await fetchOnce(site);
		expect(plan).toMatchObject({ added: 1, deleted: ['4'] });
		expect(calls).toEqual(['list 1', 'read 31', 'read 4']);
		expect(counts).toMatchObject({ new: 1, gone: 1 });
	});
});
