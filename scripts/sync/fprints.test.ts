import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { siteImage } from '../screenshots/site-images';
import { FPRINTS_API, FPRINTS_SITEMAP, fprintsRecord, fprintsSite, noSuchRow, parseSitemap, type FprintsRow } from './fprints';
import { applyPoll, planPoll, PoliteHttp, readState } from './polled';

const A = 'ed43db36-b063-41d5-b1ac-99fdd3550ed4';
const B = '89431eca-2ea7-4844-99f3-d543b860ff6e';
const C = '002def46-9888-48e3-808b-483a4367fbbe';

const url = (loc: string, lastmod?: string) => `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
const sitemap = (...urls: string[]) =>
	`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('\n')}</urlset>`;

/** A made-up row in the API's shape (no player's work). */
const row = (o: Partial<FprintsRow> = {}): FprintsRow => ({
	id: A,
	user_id: '177bc5fb-4dd4-43a5-bd9e-e46b9edfb87c',
	title: '  Test smelter  ',
	description: 'More at https://example.com/notes, see https://factorioprints.com/view/-AAAAAAAAAAAAAAAAAAAA.',
	blueprint_string: '0eTEST\n',
	created_at: '2026-10-12T22:11:39.568184+00:00',
	updated_at: '2026-10-12T22:42:29.334+00:00',
	is_public: true,
	image_url: 'https://fprints-data.b-cdn.net/uploads/95699d0d-c28b-4dcc-bfcd-257be9434b37.webp',
	game_version: '2.1.21',
	type: 'blueprint_book',
	remixed_from_url: 'https://www.factorio.school/view/-BBBBBBBBBBBBBBBBBBBB',
	...o
});

describe('parseSitemap', () => {
	test('each print once, with its lastmod; other URLs and other hosts skipped', () => {
		expect(
			parseSitemap(
				sitemap(
					url('https://fprints.xyz/', '2026-10-12T22:42:29.334Z'),
					url(`https://fprints.xyz/blueprint/${A}`, '2026-10-12T22:42:29.334Z'),
					url(`https://fprints.xyz/blueprint/${B}`, 'not a date'),
					url(`https://fprints.xyz/blueprint/${A}`, '2020-01-01'),
					url('https://fprints.xyz/blueprint/not-a-uuid'),
					url(`https://evil.example/blueprint/${C}`),
					url(`https://fprints.xyz/blueprint/${C.toUpperCase()}`)
				)
			)
		).toEqual([
			{ uuid: A, lastmod: Date.parse('2026-10-12T22:42:29.334Z') },
			{ uuid: B, lastmod: null },
			{ uuid: C, lastmod: null }
		]);
	});

	test('an error page is no sitemap: an error, never "no prints"', () => {
		expect(() => parseSitemap('<html><body>502 Bad Gateway</body></html>')).toThrow('not a whole sitemap');
		expect(parseSitemap(sitemap())).toEqual([]);
		// Cut short: an error, never "every print after the cut gone".
		const whole = sitemap(url(`https://fprints.xyz/blueprint/${A}`, '2026-10-12T22:42:29.334Z'), url(`https://fprints.xyz/blueprint/${B}`));
		expect(() => parseSitemap(whole.slice(0, whole.indexOf(B)))).toThrow('not a whole sitemap');
		expect(parseSitemap(`${whole}\n`).length).toBe(2);
	});
});

describe('fprintsRecord', () => {
	test('a public row as a SourceRecord: string, author by id, times, version tag, links (not the remix), its image', () => {
		const got = fprintsRecord(A, row());
		if (!('record' in got)) throw new Error(got.gone);
		expect(got.record).toEqual({
			site: 'fprints',
			siteId: A,
			url: `https://fprints.xyz/blueprint/${A}`,
			title: 'Test smelter',
			description: row().description,
			author: { site: 'fprints', id: '177bc5fb-4dd4-43a5-bd9e-e46b9edfb87c', name: null },
			blueprintString: '0eTEST',
			image: { key: siteImage('fprints', row().image_url)!.key, url: row().image_url },
			uploadedAt: Date.parse('2026-10-12T22:11:39.568Z'),
			updatedAt: Date.parse('2026-10-12T22:42:29.334Z'),
			favorites: null,
			tags: ['/version/2,1/'],
			// remixed_from_url names the print this one was made from: another print, so no hint.
			sourceHints: ['https://example.com/notes', 'https://factorioprints.com/view/-AAAAAAAAAAAAAAAAAAAA']
		});
		expect(/^fprints\.[0-9a-f]{16}$/.test(got.record.image!.key)).toBe(true);
	});

	test('not public: gone; no string or another id: an error; empty fields null; images elsewhere not copied', () => {
		expect(fprintsRecord(A, row({ is_public: false }))).toEqual({ gone: 'no longer public' });
		// No is_public at all: public (the sitemap listed it); the API's id in capitals is the same print.
		expect('record' in fprintsRecord(A, row({ is_public: undefined }))).toBe(true);
		expect('record' in fprintsRecord(A, row({ id: A.toUpperCase() }))).toBe(true);
		expect(() => fprintsRecord(A, row({ blueprint_string: ' ' }))).toThrow('no blueprint string');
		expect(() => fprintsRecord(B, row())).toThrow('the API answered for');
		const bare = fprintsRecord(
			A,
			row({ title: '', description: '', user_id: null, remixed_from_url: null, game_version: null, image_url: null })
		);
		if (!('record' in bare)) throw new Error(bare.gone);
		expect([
			bare.record.title,
			bare.record.description,
			bare.record.author,
			bare.record.tags,
			bare.record.sourceHints,
			bare.record.image
		]).toEqual([null, null, null, [], [], null]);
		for (const elsewhere of ['https://i.imgur.com/AbC123x.png', 'http://fprints-data.b-cdn.net/x.webp', 'https://other.b-cdn.net/x.webp']) {
			const r = fprintsRecord(A, row({ image_url: elsewhere }));
			expect('record' in r && r.record.image).toBeNull();
		}
	});

	test('the API\'s "no rows" answer means no such print; other 500s do not', () => {
		expect(noSuchRow(500, '{"error":"JSON object requested, multiple (or no) rows returned"}')).toBe(true);
		expect(noSuchRow(500, '{"error":"upstream timeout"}')).toBe(false);
		expect(noSuchRow(502, 'multiple (or no) rows returned')).toBe(false);
	});
});

describe('fprints through the polled framework', () => {
	let inbox: string;
	beforeEach(async () => {
		inbox = await mkdtemp(join(tmpdir(), 'fprints-'));
	});
	afterEach(async () => {
		await rm(inbox, { recursive: true, force: true });
	});

	/** A fake fprints.xyz: `listed` (uuid → lastmod) on the sitemap, `rows` behind the API (absent: the "no rows" 500). */
	const fakeSite = (listed: Map<string, string>, rows: Map<string, FprintsRow>) => {
		const calls: string[] = [];
		const http = new PoliteHttp({
			minIntervalMs: 0,
			sleep: async () => undefined,
			fetch: (async (u: string) => {
				if (u === FPRINTS_SITEMAP) {
					calls.push('sitemap');
					return new Response(
						sitemap(url('https://fprints.xyz/'), ...[...listed].map(([id, t]) => url(`https://fprints.xyz/blueprint/${id}`, t)))
					);
				}
				const id = new URL(u).searchParams.get('id')!;
				expect(u.startsWith(`${FPRINTS_API}?id=`)).toBe(true);
				calls.push(`read ${id.slice(0, 1)}`);
				const r = rows.get(id);
				return r ? Response.json(r) : Response.json({ error: 'JSON object requested, multiple (or no) rows returned' }, { status: 500 });
			}) as unknown as typeof fetch
		});
		const fetchOnce = async () => {
			const state = await readState(inbox, 'fprints');
			const { plan, work } = await planPoll(fprintsSite, state, http, { maxChange: 0.5 });
			if (plan.blocked || plan.from.id === plan.to.id) return { plan, counts: null, state };
			const counts = await applyPoll(fprintsSite, inbox, state, work, http, { perUpdate: 100, maxChange: 0.5 });
			return { plan, counts, state: await readState(inbox, 'fprints') };
		};
		return { calls, fetchOnce };
	};

	test('first import, a quiet update, an edit, a deletion confirmed by the API', async () => {
		const listed = new Map([
			[A, '2026-10-01T00:00:00Z'],
			[B, '2026-09-01T00:00:00Z'],
			[C, '2026-09-15T00:00:00Z']
		]);
		const rows = new Map([A, B, C].map((id) => [id, row({ id, updated_at: listed.get(id) })]));
		const { calls, fetchOnce } = fakeSite(listed, rows);

		const first = await fetchOnce();
		expect(first.plan).toMatchObject({ site: 'fprints', kind: 'fprints.xyz sitemap', polled: true, prints: 3, added: 3 });
		expect(calls).toEqual(['sitemap', 'read 8', 'read 0', 'read e']);
		expect(first.counts).toMatchObject({ new: 3, failed: 0 });
		expect(JSON.parse(await readFile(join(inbox, 'fprints', `${A}.json`), 'utf8'))).toMatchObject({ site: 'fprints', siteId: A });

		calls.length = 0;
		const quiet = await fetchOnce();
		expect(quiet.plan.from.id).toBe(quiet.plan.to.id);
		expect(calls).toEqual(['sitemap']);

		calls.length = 0;
		listed.set(B, '2026-10-20T00:00:00Z');
		rows.set(B, row({ id: B, title: 'Edited', updated_at: '2026-10-20T00:00:00Z' }));
		listed.delete(C);
		rows.delete(C);
		const edited = await fetchOnce();
		expect(edited.plan).toMatchObject({ added: 0, edited: 1, deleted: [C] });
		expect(calls).toEqual(['sitemap', 'read 8', 'read 0']);
		expect(edited.counts).toMatchObject({ changed: 1, rewritten: 1, gone: 1, failed: 0 });
		expect(Object.keys(edited.state.gone)).toEqual([C]);
	});

	test('a print the sitemap lists but the API has no row for is a failed read, never gone; a broken sitemap fails the plan', async () => {
		const listed = new Map([
			[A, '2026-10-01T00:00:00Z'],
			[B, '2026-09-01T00:00:00Z']
		]);
		const rows = new Map([[A, row()]]);
		const { calls, fetchOnce } = fakeSite(listed, rows);
		const r = await fetchOnce();
		expect(r.counts).toMatchObject({ new: 1, failed: 1, gone: 0 });
		expect(r.state.pending[B]).toBe(`${Date.parse('2026-09-01T00:00:00Z')}#1`);
		// The "no rows" answer is not retried.
		expect(calls.filter((c) => c === 'read 8').length).toBe(1);

		const broken = new PoliteHttp({
			minIntervalMs: 0,
			fetch: (async () => new Response('<html>oops</html>')) as unknown as typeof fetch
		});
		await expect(planPoll(fprintsSite, await readState(inbox, 'fprints'), broken, { maxChange: 0.05 })).rejects.toThrow(
			'not a whole sitemap'
		);
	});
});
