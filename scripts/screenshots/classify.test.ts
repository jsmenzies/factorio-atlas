import { describe, expect, test } from 'bun:test';
import { classify, etagMd5, REMOVED_MD5, type Reply } from './classify.js';
import { md5 } from './image.js';

/** A 1 × 1 PNG header is enough for sniff and imageSize. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 3, 0, 0, 0, 2]);
const ok = (over: Partial<Reply> = {}): Reply => ({
	status: 200,
	location: null,
	contentType: 'image/png',
	etag: `"${md5(PNG)}"`,
	body: PNG,
	...over
});

describe('classify', () => {
	test('a good original', () => {
		expect(classify(ok())).toEqual({ kind: 'ok', type: 'png', ext: 'png', md5: md5(PNG), bytes: PNG.length, width: 3, height: 2 });
	});

	test('dead: removed.png redirect, 404, 410, or removed.png itself', () => {
		expect(classify({ ...ok(), status: 302, body: null, location: 'https://i.imgur.com/removed.png' }).kind).toBe('dead');
		expect(classify({ ...ok(), status: 404, body: null }).kind).toBe('dead');
		expect(classify({ ...ok(), status: 410, body: null }).kind).toBe('dead');
		expect(classify(ok(), () => REMOVED_MD5).kind).toBe('dead');
	});

	test('stop the run: 429, 403, a web page', () => {
		expect(classify({ ...ok(), status: 429, body: null }).kind).toBe('stop');
		expect(classify({ ...ok(), status: 403, body: null }).kind).toBe('stop');
		expect(classify(ok({ contentType: 'text/html; charset=utf-8' })).kind).toBe('stop');
	});

	test('retry: 5xx, 408, an empty body, a body that is not what the ETag says', () => {
		expect(classify({ ...ok(), status: 503, body: null }).kind).toBe('retry');
		expect(classify({ ...ok(), status: 408, body: null }).kind).toBe('retry');
		expect(classify(ok({ body: new Uint8Array() })).kind).toBe('retry');
		expect(classify(ok({ etag: '"00000000000000000000000000000000"' })).kind).toBe('retry');
	});

	test('failed: other redirects, other 4xx, wrong or unknown format, no ETag', () => {
		expect(classify({ ...ok(), status: 302, body: null, location: 'https://imgur.com/abc' })).toEqual({
			kind: 'failed',
			reason: 'HTTP 302 to https://imgur.com/abc'
		});
		expect(classify({ ...ok(), status: 400, body: null }).kind).toBe('failed');
		expect(classify(ok({ contentType: 'image/jpeg' }))).toEqual({ kind: 'failed', reason: 'content-type says jpeg, bytes are png' });
		expect(classify(ok({ contentType: 'video/mp4' })).kind).toBe('failed');
		expect(classify(ok({ body: new TextEncoder().encode('hello'), etag: null })).kind).toBe('failed');
		expect(classify(ok({ etag: null })).kind).toBe('failed');
	});
});

test('etagMd5', () => {
	expect(etagMd5('"58B12B0030452EA6180F464EFE5CA515"')).toBe('58b12b0030452ea6180f464efe5ca515');
	expect(etagMd5('W/"58b12b0030452ea6180f464efe5ca515"')).toBe('58b12b0030452ea6180f464efe5ca515');
	expect(etagMd5('"58b12b0030452ea6180f464efe5ca515-3"')).toBeNull();
	expect(etagMd5(null)).toBeNull();
});
