import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { RENDER_FILE } from '#lib/viewer/game-render.js';
import { THUMB, THUMB_FILE, thumbFile, thumbSize, thumbSrcset, thumbTiers, type ThumbsIndex } from '#lib/viewer/thumbs.js';
import { planThumbUpload, thumbKeys } from './thumbs-upload.js';
import { finishPrint, makePage, mapPool, planPrint } from './thumbs.js';

test('a tier is the 16:9 box the thumbnail fits in, never larger than the overview', () => {
	// Square 2000 px: 180 × 180 in the 320 box.
	expect(thumbSize(2000, 2000, 320)).toMatchObject({ width: 180, height: 180 });
	// Very wide: limited by the width.
	expect(thumbSize(2000, 100, 640)).toMatchObject({ width: 640, height: 32 });
	// Smaller than the box: its own size.
	expect(thumbSize(256, 192, 640)).toEqual({ width: 256, height: 192, scale: 1 });
	expect(thumbTiers(2000, 2000)).toEqual([320, 640, 960]);
	// 256 × 192 can't fill a box past 320 × 180: 320, then 640 at its own size, no 960.
	expect(thumbTiers(256, 192)).toEqual([320, 640]);
	expect(thumbTiers(64, 64)).toEqual([320]);
	expect(thumbTiers(700, 300)).toEqual([320, 640, 960]);
	expect(thumbTiers(600, 300)).toEqual([320, 640]);
});

test('thumbnail names carry the page, the overview stamp and the tier, and fit RENDER_FILE', () => {
	expect(thumbFile('', '0123456789', 320)).toBe('root.0123456789.t320.avif');
	expect(thumbFile('3/1', '0123456789', 960)).toBe('3/1.0123456789.t960.avif');
	for (const f of [thumbFile('', '0123456789', 320), thumbFile('12/4', 'abcdef0123', 640), 'root.0123456789.t320-v2.avif']) {
		expect(THUMB_FILE.test(f)).toBe(true);
		expect(RENDER_FILE.test(f)).toBe(true);
	}
	expect(THUMB_FILE.test('root.0123456789.avif')).toBe(false);
	expect(thumbSrcset('/r/x', '', { stamp: '0123456789', sizes: [320, 640] })).toBe(
		'/r/x/root.0123456789.t320.avif 320w, /r/x/root.0123456789.t640.avif 640w'
	);
	expect(THUMB).toEqual({ format: 'avif', quality: 80, effort: 1 });
});

test('mapPool keeps the order and the limit', async () => {
	let running = 0;
	let peak = 0;
	const out = await mapPool([5, 1, 3, 2, 4], 2, async (n) => {
		peak = Math.max(peak, ++running);
		await new Promise((r) => setTimeout(r, n));
		running--;
		return n * 10;
	});
	expect(out).toEqual([50, 10, 30, 20, 40]);
	expect(peak).toBe(2);
});

const index = (pages: ThumbsIndex['pages']): ThumbsIndex => ({ v: 1, pages });

test('an upload puts what is new, then lists it, and schedules what went', () => {
	const a = { stamp: '0123456789', w: 2000, h: 2000, sizes: [320, 640, 960] };
	const b = { stamp: 'abcdef0123', w: 100, h: 100, sizes: [320] };
	expect(planThumbUpload(index({ '': a }), index({ '': a })).unchanged).toBe(true);
	expect(planThumbUpload(null, null).unchanged).toBe(true);
	const first = planThumbUpload(index({ '': a }), null);
	expect(first.put).toEqual(['root.0123456789.t320.avif', 'root.0123456789.t640.avif', 'root.0123456789.t960.avif']);
	expect(first.remove).toEqual([]);
	// The page redrawn (new stamp), another page added.
	const redraw = planThumbUpload(index({ '': { ...a, stamp: 'fedcba9876' }, '1': b }), index({ '': a }));
	expect(redraw.put.sort()).toEqual([
		'1.abcdef0123.t320.avif',
		'root.fedcba9876.t320.avif',
		'root.fedcba9876.t640.avif',
		'root.fedcba9876.t960.avif'
	]);
	expect(redraw.remove).toEqual(['root.0123456789.t320.avif', 'root.0123456789.t640.avif', 'root.0123456789.t960.avif']);
	// Thumbnails gone from disk: an empty list goes up, every file is scheduled.
	const gone = planThumbUpload(null, index({ '1': b }));
	expect(gone.index).toEqual(index({}));
	expect(gone.remove).toEqual(['1.abcdef0123.t320.avif']);
	expect(thumbKeys(index({ '1': b }))).toEqual(new Set(['1.abcdef0123.t320.avif']));
});

test('pages are made at their tiers, listed in book order, kept while their stamp holds and swept when it changes', async () => {
	const tmp = mkdtempSync(join(tmpdir(), 'thumbs-test-'));
	try {
		await pagesRoundTrip(tmp);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

async function pagesRoundTrip(tmp: string) {
	const renders = join(tmp, 'renders');
	const out = join(tmp, 'thumbs');
	const id = 'print1';
	await mkdir(join(renders, id, '1'), { recursive: true });
	const overview = (w: number, h: number) =>
		sharp({ create: { width: w, height: h, channels: 4, background: { r: 200, g: 120, b: 40, alpha: 0.5 } } })
			.avif()
			.toBuffer();
	await writeFile(join(renders, id, '0.0123456789.avif'), await overview(1200, 600));
	await writeFile(join(renders, id, '1/0.abcdef0123.avif'), await overview(200, 100));
	const renderIndex = (stamp0: string) => ({
		v: 2,
		cover: '0',
		pages: { '0': { stamp: stamp0, overview: `0.${stamp0}.avif` }, '1/0': { stamp: 'abcdef0123', overview: '1/0.abcdef0123.avif' } }
	});
	await writeFile(join(renders, id, 'index.json'), JSON.stringify(renderIndex('0123456789')));

	const run = async () => {
		const plan = (await planPrint(renders, out, id))!;
		const made = await Promise.all(plan.jobs.map((j) => makePage(renders, out, j)));
		const pages = { ...plan.kept };
		plan.jobs.forEach((j, i) => (pages[j.path] = made[i]!.page));
		const removed = await finishPrint(out, id, plan.order, pages);
		return { plan, made, removed };
	};
	const first = await run();
	expect(first.plan.jobs.length).toBe(2);
	const thumbs = JSON.parse(await readFile(join(out, id, 'thumbs.json'), 'utf8')) as ThumbsIndex;
	expect(Object.keys(thumbs.pages)).toEqual(['0', '1/0']);
	expect(thumbs.pages['0']).toEqual({ stamp: '0123456789', w: 1200, h: 600, sizes: [320, 640, 960] });
	// 200 × 100 fills no box: one tier, at its own size.
	expect(thumbs.pages['1/0'].sizes).toEqual([320]);
	expect(first.made[1]!.clamped).toBe(true);
	const meta = await sharp(join(out, id, '0.0123456789.t640.avif')).metadata();
	expect([meta.width, meta.height, meta.hasAlpha]).toEqual([640, 320, true]);

	expect((await run()).plan.jobs.length).toBe(0);

	// Page 0 redrawn: only it is made again, and its old files go.
	await writeFile(join(renders, id, '0.fedcba9876.avif'), await overview(1200, 600));
	await writeFile(join(renders, id, 'index.json'), JSON.stringify(renderIndex('fedcba9876')));
	const third = await run();
	expect(third.plan.jobs.map((j) => j.path)).toEqual(['0']);
	expect(third.removed).toBe(3);
	expect((await readdir(join(out, id))).filter((f) => f.endsWith('.avif')).sort()).toEqual([
		'0.fedcba9876.t320.avif',
		'0.fedcba9876.t640.avif',
		'0.fedcba9876.t960.avif'
	]);
}
