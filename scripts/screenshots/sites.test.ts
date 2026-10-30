import { describe, expect, test } from 'bun:test';
import { toPipelineText, type SourceRecord } from '#lib/server/pipeline/source-record.js';
import { allowedImageUrl, imageUrlOf, MAX_IMAGE_BYTES, siteImage } from './site-images.js';
import { imageFetcher, planSiteImages, siteImageEntry } from './sites.js';
import type { StateEntry } from './state.js';

// A 3 × 2 PNG header (IHDR) is all the entry reads.
const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0
]);
/** A body of `n` chunks of `size` bytes, one buffer reused, with no Content-Length. */
const chunked = (n: number, size: number) => {
	const chunk = new Uint8Array(size);
	let left = n;
	return new ReadableStream<Uint8Array>({
		pull(c) {
			if (left-- > 0) c.enqueue(chunk);
			else c.close();
		}
	});
};
const URL_A = 'https://factoriocodex.s3.us-west-000.backblazeb2.com/1793299168947779659-abc.png';
const entry = (id: string, status: StateEntry['status'], file?: string): StateEntry => ({
	id,
	status,
	prints: [],
	labelled: null,
	attempts: 1,
	at: '',
	...(file ? { file } : {})
});

describe('site images', () => {
	test('https on the site’s own image hosts only; the id is the URL’s hash', () => {
		const img = siteImage('codex', URL_A)!;
		expect(/^codex\.[0-9a-f]{16}$/.test(img.key)).toBe(true);
		expect(img.url).toBe(URL_A);
		expect(siteImage('codex', URL_A)!.key).toBe(img.key);
		expect(siteImage('codex', URL_A.replace('abc', 'abd'))!.key).not.toBe(img.key);
		for (const bad of [
			'http://factoriocodex.s3.us-west-000.backblazeb2.com/x.png',
			'https://example.com/x.png',
			'https://x@factoriocodex.s3.us-west-000.backblazeb2.com/x.png',
			'not a url',
			null
		])
			expect(allowedImageUrl('codex', bad)).toBeNull();
		expect(siteImage('fprints', URL_A)).toBeNull();
		// Another Backblaze bucket is not codex's.
		expect(allowedImageUrl('codex', 'https://someone-else.s3.us-west-000.backblazeb2.com/x.png')).toBeNull();
		// fprints: its own Bunny CDN zone only, and never another site's host.
		const bunny = 'https://fprints-data.b-cdn.net/uploads/95699d0d-c28b-4dcc-bfcd-257be9434b37.webp';
		expect(allowedImageUrl('fprints', bunny)).toBe(bunny);
		expect(/^fprints\.[0-9a-f]{16}$/.test(siteImage('fprints', bunny)!.key)).toBe(true);
		for (const bad of [
			'https://other.b-cdn.net/x.webp',
			'https://fprints-data.b-cdn.net.evil.com/x.webp',
			'https://i.imgur.com/AbC123x.png',
			URL_A
		])
			expect(allowedImageUrl('fprints', bad)).toBeNull();
		expect(allowedImageUrl('codex', bunny)).toBeNull();
	});

	test("the URL comes from the print's archived record, checked against the id", () => {
		const record: SourceRecord = {
			site: 'codex',
			siteId: '5',
			url: 'https://factoriocodex.com/blueprints/5',
			title: 't',
			description: null,
			author: null,
			blueprintString: '0e',
			image: siteImage('codex', URL_A),
			uploadedAt: 1,
			updatedAt: 1,
			favorites: null,
			sourceHints: []
		};
		const text = toPipelineText(record);
		expect(imageUrlOf(text, record.image!.key)).toBe(URL_A);
		expect(imageUrlOf(text, 'codex.0000000000000000')).toBeNull();
		expect(imageUrlOf('{}', record.image!.key)).toBeNull();
	});

	test('plans what is not copied; dead and removed never again; bytes become a fetched entry', () => {
		const state = new Map<string, StateEntry>([
			['codex.aaaaaaaaaaaaaaaa', entry('codex.aaaaaaaaaaaaaaaa', 'fetched', 'originals/co/a.png')],
			['codex.bbbbbbbbbbbbbbbb', entry('codex.bbbbbbbbbbbbbbbb', 'dead')],
			['codex.cccccccccccccccc', entry('codex.cccccccccccccccc', 'removed')],
			['codex.dddddddddddddddd', entry('codex.dddddddddddddddd', 'failed')]
		]);
		const shown = ['a', 'b', 'c', 'd', 'e'].map((c) => ({ id: `codex.${c.repeat(16)}`, prints: ['codex-1'], rawKey: 'codex/1.json' }));
		const plan = planSiteImages(shown, state, (e) => e.file === 'originals/co/a.png');
		expect([plan.done, plan.dead, plan.removed]).toEqual([1, 1, 1]);
		expect(plan.todo.map((s) => s.id)).toEqual(['codex.dddddddddddddddd', 'codex.eeeeeeeeeeeeeeee']);
		expect(siteImageEntry({ id: 'codex.eeeeeeeeeeeeeeee', prints: ['codex-1'] }, PNG, 'now')).toMatchObject({
			status: 'fetched',
			file: 'originals/co/codex.eeeeeeeeeeeeeeee.png',
			type: 'png',
			width: 3,
			height: 2
		});
		expect(siteImageEntry({ id: 'codex.eeeeeeeeeeeeeeee', prints: [] }, new Uint8Array([1, 2, 3]), 'now')).toMatchObject({
			status: 'failed'
		});
		// A failed image (e.g. "over 30 MB" before the cap went up) is planned again on the next run.
		expect(
			planSiteImages([shown[3]], new Map([[shown[3].id, { ...entry(shown[3].id, 'failed'), reason: 'over 30 MB from x' }]]), () => true)
				.todo
		).toEqual([shown[3]]);
	});

	test('the fetch: a User-Agent, no Referer, retried on 5xx, 404 passed back', async () => {
		const seen: RequestInit[] = [];
		const answers = [
			new Response('', { status: 502 }),
			new Response(PNG),
			new Response('', { status: 404 }),
			new Response('', { status: 302, headers: { location: 'https://elsewhere.example/x.png' } }),
			// Over the old 30 MB cap, under the 100 MB one: the size of codex's largest image (codex-487, 97,279,019 bytes).
			new Response(chunked(1, 97_279_019)),
			new Response(new Uint8Array(1), { headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) } }),
			// No length given: cut off by the running count once past the cap, never buffered whole.
			new Response(chunked(101, 1024 * 1024))
		];
		const get = imageFetcher({
			minIntervalMs: 0,
			sleep: async () => undefined,
			fetch: (async (_url: string, init: RequestInit) => {
				seen.push(init);
				return answers.shift()!;
			}) as unknown as typeof fetch
		});
		expect(await get(URL_A)).toEqual({ bytes: PNG });
		expect(await get(URL_A)).toEqual({ status: 404, reason: 'HTTP 404' });
		expect(await get(URL_A)).toMatchObject({ status: 302 });
		expect(((await get(URL_A)) as { bytes: Uint8Array }).bytes.length).toBe(97_279_019);
		expect(await get(URL_A)).toEqual({ status: 200, reason: 'over 100 MB' });
		expect(await get(URL_A)).toEqual({ status: 200, reason: 'over 100 MB' });
		expect(new Headers(seen[0].headers).get('user-agent')).toContain('factorio-atlas');
		expect(seen[0].referrerPolicy).toBe('no-referrer');
		expect(seen[0].redirect).toBe('manual');
	});
});
