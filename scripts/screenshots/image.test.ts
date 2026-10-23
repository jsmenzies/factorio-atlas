import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { imageSize, kindOfMime, md5, requestExt, sniff } from './image.js';

const make = (format: 'png' | 'jpeg' | 'gif' | 'webp', opts: Record<string, unknown> = {}) =>
	sharp({ create: { width: 37, height: 21, channels: 3, background: '#c08040' } })
		[format](opts)
		.toBuffer()
		.then((b) => new Uint8Array(b));

describe('sniff and imageSize', () => {
	const cases: [Parameters<typeof make>[0], Record<string, unknown>][] = [
		['png', {}],
		['jpeg', {}],
		['jpeg', { progressive: true }],
		['gif', {}],
		['webp', {}],
		['webp', { lossless: true }]
	];
	for (const [format, opts] of cases)
		test(`${format} ${JSON.stringify(opts)}`, async () => {
			const b = await make(format, opts);
			expect(sniff(b)).toBe(format);
			expect(imageSize(b, format)).toEqual({ width: 37, height: 21 });
		});

	test('a JPEG with metadata before its frame', async () => {
		const b = new Uint8Array(
			await sharp({ create: { width: 640, height: 400, channels: 3, background: '#000' } })
				.withExif({ IFD0: { ImageDescription: 'x'.repeat(300) } })
				.jpeg()
				.toBuffer()
		);
		expect(imageSize(b, 'jpeg')).toEqual({ width: 640, height: 400 });
	});

	test('not an image, or cut short', () => {
		expect(sniff(new TextEncoder().encode('<!doctype html>'))).toBeNull();
		expect(sniff(new Uint8Array([0xff, 0xd8]))).toBeNull();
		expect(imageSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'png')).toBeNull();
		expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), 'jpeg')).toBeNull();
	});
});

test('kindOfMime and requestExt', () => {
	expect(kindOfMime('image/jpeg; charset=binary')).toBe('jpeg');
	expect(kindOfMime('IMAGE/PNG')).toBe('png');
	expect(kindOfMime('video/mp4')).toBeNull();
	expect(kindOfMime(null)).toBeNull();
	expect(requestExt('image/png')).toBe('png');
	expect(requestExt('image/gif')).toBe('gif');
	expect(requestExt(null)).toBe('jpg');
});

test('md5', () => {
	expect(md5(new TextEncoder().encode('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
});
