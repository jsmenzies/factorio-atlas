import { describe, expect, test } from 'bun:test';
import {
	capSize,
	cardImage,
	cropBox,
	overCap,
	parseManifest,
	SHOT_KEY,
	shotFiles,
	shotKeys,
	shotView,
	type CardImageColumns,
	type Shot
} from './screenshots.js';

const shot = (w: number, h: number, ext = 'png'): Shot => ({ id: 'AbCd123', v: 1, ext, w, h });

describe('sizes', () => {
	test('cropBox is the largest centred 16:9 region', () => {
		expect(cropBox(1920, 1080)).toEqual({ width: 1920, height: 1080 });
		expect(cropBox(1000, 1000)).toEqual({ width: 1000, height: 563 });
		expect(cropBox(11584, 456)).toEqual({ width: 811, height: 456 });
	});

	test('crop tiers are never enlarged: a small screenshot stops at its own size', () => {
		const big = shotFiles(shot(1920, 1080)).crops;
		expect(big.map((c) => [c.tier, c.width, c.height])).toEqual([
			[320, 320, 180],
			[640, 640, 360],
			[960, 960, 540]
		]);
		const small = shotFiles(shot(500, 400)).crops;
		expect(small.map((c) => [c.tier, c.width, c.height])).toEqual([
			[320, 320, 180],
			[640, 500, 281]
		]);
	});

	test('large and preview fit their box, never enlarged', () => {
		const f = shotFiles(shot(5000, 2500, 'jpg'));
		expect(f.large).toEqual({ key: 'AbCd123.v1.l.avif', width: 2560, height: 1280 });
		expect(f.og).toEqual({ key: 'AbCd123.v1.og.jpg', width: 1200, height: 600 });
		expect(shotFiles(shot(800, 600)).large).toMatchObject({ width: 800, height: 600 });
	});

	test('the full size: the original, or scaled down over the cap (JPEG stays JPEG, PNG becomes WebP, GIF is kept)', () => {
		expect(shotFiles(shot(1920, 1080)).full).toEqual({ key: 'AbCd123.png', width: 1920, height: 1080, capped: false });
		expect(overCap(3840, 2160)).toBe(false);
		expect(overCap(4000, 4000)).toBe(true);
		expect(overCap(9000, 400)).toBe(true);
		const j = shotFiles(shot(6000, 4000, 'jpg')).full;
		expect(j).toMatchObject({ key: 'AbCd123.v1.full.jpg', capped: true });
		expect(j.width * j.height <= 3840 * 2160).toBe(true);
		expect(shotFiles(shot(4688, 4688)).full.key).toBe('AbCd123.v1.full.webp');
		expect(shotFiles(shot(5000, 5000, 'gif')).full).toMatchObject({ key: 'AbCd123.gif', capped: false });
		expect(capSize(11584, 456)).toEqual({ width: 8192, height: 322 });
	});

	test('every key is one the route serves', () => {
		for (const k of [...shotKeys(shot(6000, 4000, 'jpg')), ...shotKeys(shot(300, 200, 'gif')), 'AbCd123.json'])
			expect(SHOT_KEY.test(k)).toBe(true);
		for (const k of ['../x.json', 'AbCd123.v1.c320.png', 'AbCd123', 'a/b.jpg']) expect(SHOT_KEY.test(k)).toBe(false);
	});
});

describe('cardImage', () => {
	const card = (over: Partial<CardImageColumns> = {}): CardImageColumns => ({
		id: '-AAAAAAAAAAAAAAAAAAA',
		image_id: 'AbCd123',
		image_type: 'image/png',
		shot_state: null,
		shot_v: null,
		shot_ext: null,
		shot_w: null,
		shot_h: null,
		cover_page: null,
		cover_stamp: null,
		cover_w: null,
		cover_h: null,
		...over
	});
	const bases = { shots: 'https://s.example.com', renderBase: (id: string) => `https://r.example.com/${id}` };
	const copied = { shot_state: 'copied', shot_v: 1, shot_ext: 'png', shot_w: 1920, shot_h: 1080 };
	const cover = { cover_page: '', cover_stamp: '0123456789', cover_w: 4000, cover_h: 2000 };
	const renderSrc = 'https://r.example.com/-AAAAAAAAAAAAAAAAAAA/root.0123456789.t320.avif';

	test('copied: our crops, before anything else', () => {
		expect(cardImage(card({ ...copied, ...cover }), bases)).toEqual({
			kind: 'screenshot',
			src: 'https://s.example.com/AbCd123.v1.c320.avif',
			srcset:
				'https://s.example.com/AbCd123.v1.c320.avif 320w, https://s.example.com/AbCd123.v1.c640.avif 640w, https://s.example.com/AbCd123.v1.c960.avif 960w',
			width: 320,
			height: 180
		});
	});

	test('dead or removed: the render thumbnail, else nothing; never Imgur', () => {
		for (const shot_state of ['dead', 'removed']) {
			expect(cardImage(card({ shot_state, ...cover }), bases)).toMatchObject({ kind: 'render', src: renderSrc });
			expect(cardImage(card({ shot_state }), bases)).toBeNull();
		}
	});

	test("unknown (no row): Imgur's 640 px copy first, as before the copies; without a screenshot, the render, else nothing", () => {
		expect(cardImage(card(cover), bases)).toEqual({ kind: 'imgur', src: 'https://i.imgur.com/AbCd123l.png', width: 640, height: 360 });
		expect(cardImage(card({ image_id: null, image_type: null, ...cover }), bases)).toMatchObject({ kind: 'render', src: renderSrc });
		expect(cardImage(card({ image_id: null, image_type: null }), bases)).toBeNull();
	});
});

describe('shotView and parseManifest', () => {
	const copied = parseManifest({ state: 'copied', v: 1, ext: 'jpg', w: 2000, h: 1000 });

	test('copied: header crop, large, original and preview are ours', () => {
		const v = shotView('AbCd123', 'image/jpeg', copied, '/screenshots');
		expect(v).toMatchObject({ state: 'copied', imgur: false });
		expect(v.backdrop).toEqual({ src: '/screenshots/AbCd123.v1.c960.avif', width: 960, height: 540 });
		expect(v.large).toEqual({ src: '/screenshots/AbCd123.v1.l.avif', width: 2000, height: 1000 });
		expect(v.inline).toEqual({ src: '/screenshots/AbCd123.v1.og.jpg', width: 1200, height: 600 });
		expect(v.full).toEqual({ src: '/screenshots/AbCd123.jpg', width: 2000, height: 1000, capped: false });
		expect(v.og).toEqual({ src: '/screenshots/AbCd123.v1.og.jpg', width: 1200, height: 600 });
	});

	test("unknown (no manifest): Imgur's copies everywhere, as before", () => {
		expect(shotView('AbCd123', 'image/png', null, '/screenshots')).toEqual({
			state: 'unknown',
			imgur: true,
			backdrop: { src: 'https://i.imgur.com/AbCd123h.jpg', width: 1024, height: 576 },
			large: { src: 'https://i.imgur.com/AbCd123.png', width: 0, height: 0 },
			inline: { src: 'https://i.imgur.com/AbCd123l.png', width: 640, height: 360 },
			full: { src: 'https://i.imgur.com/AbCd123.png', width: 0, height: 0, capped: false },
			og: { src: 'https://i.imgur.com/AbCd123h.jpg', width: 0, height: 0 }
		});
		expect(shotView(null, null, null, '/screenshots')).toMatchObject({ imgur: false, backdrop: null, inline: null, og: null });
	});

	test('dead or removed: nothing, nor Imgur', () => {
		for (const state of ['dead', 'removed'] as const)
			expect(shotView('AbCd123', 'image/png', { state }, '/screenshots')).toEqual({
				state,
				imgur: false,
				backdrop: null,
				large: null,
				inline: null,
				full: null,
				og: null
			});
	});

	test('parseManifest refuses what isn\u2019t one', () => {
		expect(parseManifest({ state: 'copied', v: 1, ext: 'exe', w: 1, h: 1 })).toBeNull();
		expect(parseManifest({ state: 'copied', v: 1, ext: 'png', w: 0, h: 1 })).toBeNull();
		expect(parseManifest(null)).toBeNull();
		expect(parseManifest({ state: 'removed', extra: 1 })).toEqual({ state: 'removed' });
	});
});
