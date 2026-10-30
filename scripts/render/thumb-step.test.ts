import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { ThumbsIndex } from '#lib/viewer/thumbs.js';
import { createThumbStep } from './thumb-step.js';
import type { ThumbUploader } from './thumbs-upload.js';

const overview = (w: number, h: number) =>
	sharp({ create: { width: w, height: h, channels: 4, background: { r: 90, g: 160, b: 40, alpha: 0.8 } } })
		.avif()
		.toBuffer();

/** A print with pages `0` and `1` in a renders folder, page 0 at `stamp0`. */
async function render(dir: string, id: string, stamp0: string) {
	await mkdir(join(dir, id), { recursive: true });
	await writeFile(join(dir, id, `0.${stamp0}.avif`), await overview(800, 400));
	if (!existsSync(join(dir, id, '1.abcdef0123.avif'))) await writeFile(join(dir, id, '1.abcdef0123.avif'), await overview(300, 600));
	await writeFile(
		join(dir, id, 'index.json'),
		JSON.stringify({
			v: 2,
			cover: '0',
			pages: { '0': { stamp: stamp0, overview: `0.${stamp0}.avif` }, '1': { stamp: 'abcdef0123', overview: '1.abcdef0123.avif' } }
		})
	);
}

test('makes, keeps, renews and clears thumbnails; uploads each print after its render files settle', async () => {
	const tmp = mkdtempSync(join(tmpdir(), 'thumb-step-'));
	try {
		const renders = join(tmp, 'renders');
		const thumbs = join(tmp, 'thumbs');
		const events: string[] = [];
		const uploader = {
			uploadPrint: async (id: string) => {
				events.push(`upload ${id}`);
				return true;
			}
		} as unknown as ThumbUploader;
		const progress: { done: number; of: number }[] = [];
		const step = (planOnly = false) => {
			const made = createThumbStep({
				rendersDir: renders,
				thumbsDir: thumbs,
				concurrency: 2,
				planOnly,
				log: () => {},
				upload: planOnly
					? undefined
					: {
							uploader,
							renderFilesSettled: async (id) => {
								events.push(`settled ${id}`);
							}
						},
				stopped: () => false,
				onPrintDone: () => progress.push(made.progress)
			});
			return made;
		};
		await render(renders, 'a', '0123456789');
		await render(renders, 'b', '0123456789');

		// Planning only counts.
		const plan = step(true);
		plan.offer('a');
		plan.offer('b');
		await plan.drain();
		expect(plan.stats.pages).toBe(4);
		expect(existsSync(join(thumbs, 'a'))).toBe(false);

		const first = step();
		progress.length = 0;
		first.offer('a');
		first.offer('b');
		expect(first.progress).toEqual({ done: 0, of: 2 });
		// Offered again while being worked on: looked at once more afterwards, never twice at once.
		first.offer('a');
		await first.drain();
		// Prints, not offers: `a` counts once, and is done only after its second look.
		expect(progress.at(-1)).toEqual({ done: 2, of: 2 });
		expect(progress.every((p) => p.of === 2 && p.done <= 2)).toBe(true);
		expect(progress.length).toBe(3);
		expect(first.stats).toMatchObject({ prints: 3, current: 1, pages: 4, failed: 0 });
		const index = JSON.parse(await readFile(join(thumbs, 'a', 'thumbs.json'), 'utf8')) as ThumbsIndex;
		expect(index.pages['1']).toEqual({ stamp: 'abcdef0123', w: 300, h: 600, sizes: [320, 640, 960] });
		expect(events.filter((e) => e.endsWith(' a'))).toEqual(['settled a', 'upload a', 'settled a', 'upload a']);

		// Nothing changed: kept, still offered to the uploader (which skips an unchanged print).
		const again = step();
		again.offer('a');
		await again.drain();
		expect(again.stats).toMatchObject({ prints: 1, current: 1, pages: 0 });

		// Page 0 redrawn: only it is made again, its old thumbnails go.
		await render(renders, 'a', 'fedcba9876');
		const redrawn = step();
		redrawn.offer('a');
		await redrawn.drain();
		expect(redrawn.stats).toMatchObject({ pages: 1, removed: 3 });
		expect(existsSync(join(thumbs, 'a', '0.fedcba9876.t320.avif'))).toBe(true);
		expect(existsSync(join(thumbs, 'a', '0.0123456789.t320.avif'))).toBe(false);

		// A missing thumbnail (a gap) is made again.
		await rm(join(thumbs, 'b', '1.abcdef0123.t640.avif'));
		const gap = step();
		gap.offer('b');
		await gap.drain();
		expect(gap.stats.pages).toBe(1);
		expect(existsSync(join(thumbs, 'b', '1.abcdef0123.t640.avif'))).toBe(true);

		// The render went: so do its thumbnails.
		await rm(join(renders, 'b', 'index.json'));
		const gone = step();
		gone.offer('b');
		await gone.drain();
		expect(gone.stats.cleared).toBe(1);
		expect(JSON.parse(await readFile(join(thumbs, 'b', 'thumbs.json'), 'utf8'))).toEqual({ v: 1, pages: {} });
		expect(existsSync(join(thumbs, 'b', '0.0123456789.t320.avif'))).toBe(false);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});
