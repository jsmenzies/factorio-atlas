import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceRecord } from '#lib/server/pipeline/source-record.js';
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
		kind: 'test',
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

/** Plan then apply, as the update's fetch step does; the state as saved. */
const fetchOnce = async (site: PolledSite, perUpdate = 100, maxChange = 0.05, accept?: string) => {
	const state = await readState(inbox, 'codex');
	const h = http();
	const { plan, work } = await planPoll(site, state, h, { maxChange, accept, now: NOW });
	if (plan.blocked || plan.from.id === plan.to.id) return { plan, counts: null, state };
	const counts = await applyPoll(site, inbox, state, work, h, { perUpdate, maxChange, now: () => NOW });
	return { plan, counts, state: await readState(inbox, 'codex') };
};

describe('polled sites: fetch', () => {
	test('the first fetch lists every page and reads every print, oldest change first', async () => {
		const prints = new Map([...Array(7)].map((_, i) => [String(i + 1), 100 + i] as [string, number]));
		const { site, calls } = fakeSite(prints);
		const { plan, counts, state } = await fetchOnce(site);
		expect(plan).toMatchObject({ polled: true, added: 7, edited: 0, prints: 7, blocked: null });
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

	test('the per-update cap leaves the rest pending, read first next time', async () => {
		const prints = new Map([...Array(5)].map((_, i) => [String(i + 1), 100 + i] as [string, number]));
		const { site, calls } = fakeSite(prints);
		const first = await fetchOnce(site, 2);
		expect(first.counts).toMatchObject({ new: 2, left: 3 });
		expect(Object.keys(first.state.pending).sort()).toEqual(['3', '4', '5']);
		calls.length = 0;
		const second = await fetchOnce(site, 10);
		expect(second.counts).toMatchObject({ new: 3, left: 0 });
		expect(calls).toEqual(['list 1', 'read 3', 'read 4', 'read 5']);
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

	test('the reads find at most maxChange of the known prints gone in one fetch, whatever the plan said', async () => {
		const prints = new Map([...Array(40)].map((_, i) => [String(i + 1), 100 + i] as [string, number]));
		const { site } = fakeSite(prints, { per: 10 });
		await fetchOnce(site);
		for (const id of ['1', '2', '3']) prints.delete(id);
		const state = await readState(inbox, 'codex');
		const h = http();
		const { work } = await planPoll(site, state, h, { maxChange: 1, now: NOW });
		expect(work.missing.length).toBe(3);
		const counts = await applyPoll(site, inbox, state, work, h, { perUpdate: 100, maxChange: 0.05, now: () => NOW });
		expect(counts).toMatchObject({ gone: 2, goneHeld: 1 });
		expect(Object.keys((await readState(inbox, 'codex')).records).length).toBe(38);
	});

	test('held back when too many prints vanish from the list, or it is empty; an accepted plan goes through', async () => {
		const prints = new Map([...Array(20)].map((_, i) => [String(i + 1), 100 + i] as [string, number]));
		const { site } = fakeSite(prints, { per: 10 });
		await fetchOnce(site);
		for (const id of ['1', '2', '3']) prints.delete(id);
		const held = await fetchOnce(site, 100, 0.1);
		expect(held.plan.blocked).toContain('3 of 20 prints are missing');
		const accepted = await fetchOnce(site, 100, 0.1, held.plan.to.id);
		expect(accepted.plan.blocked).toBeNull();
		expect(accepted.counts).toMatchObject({ gone: 3 });
		prints.clear();
		expect((await fetchOnce(site)).plan.blocked).toContain('lists no prints');
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
});
