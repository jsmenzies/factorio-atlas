/**
 * The sizes the site shows, made from an original on disk with sharp (#lib/screenshots.ts names and
 * sizes them): 16:9 centre crops (AVIF), "large" for the lightbox (AVIF), the link preview (JPEG),
 * and the full size when the original is over the cap. GIFs use their first frame. Never enlarged;
 * metadata dropped, colours converted to sRGB (sharp's defaults).
 *
 * Files go to `<screenshots dir>/sizes/<first 2 chars>/<key>`, each through a temp file and a rename,
 * with `<id>.v<V>.made.json` (the original's format and size) written last: a made image has it.
 * The originals are only read.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { cropBox, SCREENSHOT_VERSION, shotFiles, type Shot } from '#lib/screenshots.js';
import { EXT, type ImageKind } from './image.js';

/** Encoder settings. Changing them changes pixels: bump SCREENSHOT_VERSION (#lib/screenshots.ts). */
export const MAKE = {
	crop: { quality: 60, effort: 2 },
	large: { quality: 75, effort: 2 },
	og: { quality: 82, mozjpeg: true },
	/** Over-cap JPEGs. */
	fullJpeg: { quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4' },
	/** Background for transparent originals in the (opaque) JPEG preview: the site's stone-900. */
	ogBackground: '#1c1917'
} as const;

export const SIZES_DIR = 'sizes';

/** A made file's path, relative to the screenshots folder. */
export const sizePath = (key: string) => `${SIZES_DIR}/${key.slice(0, 2)}/${key}`;
export const madeKey = (id: string, v = SCREENSHOT_VERSION) => `${id}.v${v}.made.json`;

/** What `madeKey` holds: the original's format and size, which the manifest repeats. */
export interface Made {
	id: string;
	v: number;
	ext: string;
	w: number;
	h: number;
	/** Bytes per key made. */
	bytes: Record<string, number>;
	ms: number;
}

const write = async (dir: string, rel: string, data: Uint8Array | string) => {
	const path = join(dir, rel);
	const tmp = `${path}.tmp-${process.pid}`;
	await mkdir(dirname(path), { recursive: true });
	try {
		await writeFile(tmp, data);
		await rename(tmp, path);
	} catch (e) {
		await rm(tmp, { force: true });
		throw e;
	}
};

/** The original's size as the site uses it (a GIF's first frame). */
export async function originalSize(bytes: Uint8Array) {
	const m = await sharp(bytes, { limitInputPixels: false }).metadata();
	if (!m.width || !m.height) throw new Error('no size in the image header');
	return { w: m.width, h: m.pageHeight ?? m.height };
}

/** Make every size of one original into `dir` (the screenshots folder) and return what was made. */
export async function makeSizes(dir: string, id: string, type: ImageKind, original: Uint8Array): Promise<Made> {
	const started = performance.now();
	const { w, h } = await originalSize(original);
	const shot: Shot = { id, v: SCREENSHOT_VERSION, ext: EXT[type], w, h };
	const files = shotFiles(shot);
	// One decoded first frame for every size; `failOn: 'error'` lets slightly odd but readable files through.
	const src = () => sharp(original, { limitInputPixels: false, failOn: 'error' });
	const bytes: Record<string, number> = {};
	const out = async (key: string, data: Buffer) => {
		bytes[key] = data.length;
		await write(dir, sizePath(key), data);
	};

	const box = cropBox(w, h);
	const left = Math.floor((w - box.width) / 2);
	const top = Math.floor((h - box.height) / 2);
	for (const c of files.crops) {
		await out(
			c.key,
			await src()
				.extract({ left, top, width: box.width, height: box.height })
				.resize(c.width, c.height, { kernel: 'lanczos3' })
				.avif(MAKE.crop)
				.toBuffer()
		);
	}
	await out(files.large.key, await src().resize(files.large.width, files.large.height, { kernel: 'lanczos3' }).avif(MAKE.large).toBuffer());
	await out(
		files.og.key,
		await src()
			.resize(files.og.width, files.og.height, { kernel: 'lanczos3' })
			.flatten({ background: MAKE.ogBackground })
			.jpeg(MAKE.og)
			.toBuffer()
	);
	if (files.full.capped) {
		const r = src().resize(files.full.width, files.full.height, { kernel: 'lanczos3' });
		await out(files.full.key, await (shot.ext === 'jpg' ? r.jpeg(MAKE.fullJpeg) : r.webp({ lossless: true })).toBuffer());
	}
	const made: Made = { id, v: SCREENSHOT_VERSION, ext: shot.ext, w, h, bytes, ms: Math.round(performance.now() - started) };
	await write(dir, sizePath(madeKey(id)), JSON.stringify(made));
	return made;
}

/** What `makeSizes` recorded for an image at this version, or null when it isn't (fully) made. */
export async function readMade(dir: string, id: string): Promise<Made | null> {
	try {
		const m = JSON.parse(await readFile(join(dir, sizePath(madeKey(id))), 'utf8')) as Made;
		return m.v === SCREENSHOT_VERSION && m.id === id ? m : null;
	} catch {
		return null;
	}
}

/** Whether the bytes decode completely (every pixel of the first frame), for originals without an MD5 to check. */
export async function decodes(bytes: Uint8Array): Promise<boolean> {
	try {
		await sharp(bytes, { limitInputPixels: false, failOn: 'warning' }).raw().toBuffer();
		return true;
	} catch {
		return false;
	}
}
