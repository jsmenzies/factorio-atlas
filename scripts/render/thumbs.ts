/**
 * Page thumbnails from render overviews (scripts/render-thumbs.ts; names, tiers and settings in
 * #lib/viewer/thumbs.ts). Reads the renders folder (index.json and overviews) and never writes to
 * it; writes only the thumbs folder. An overview is decoded once and every tier is made from the
 * decoded pixels.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import type { RenderIndex } from '#lib/viewer/game-render.js';
import { THUMB, THUMB_FILE, THUMBS_INDEX, thumbFile, thumbSize, thumbTiers, type ThumbPage, type ThumbsIndex } from '#lib/viewer/thumbs.js';

/** An overview decoded to RGBA. */
export interface Decoded {
	data: Buffer;
	width: number;
	height: number;
	ms: number;
}

export async function decodeOverview(file: string): Promise<Decoded> {
	const t = performance.now();
	const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height, ms: Math.round(performance.now() - t) };
}

const raw = (img: Decoded) => sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } });

/** One thumbnail: the overview at its own aspect within the tier's 16:9 box, never enlarged, alpha kept. */
export async function encodeThumb(
	img: Decoded,
	tier: number,
	enc: { quality: number; effort: number } = THUMB
): Promise<{ data: Buffer; width: number; height: number; ms: number }> {
	const t = performance.now();
	const { width, height } = thumbSize(img.width, img.height, tier);
	let s = raw(img);
	if (width !== img.width || height !== img.height) s = s.resize(width, height, { fit: 'fill', kernel: 'lanczos3' });
	const data = await s.avif({ quality: enc.quality, effort: enc.effort }).toBuffer();
	return { data, width, height, ms: Math.round(performance.now() - t) };
}

/** Runs `fn` over `items` with at most `limit` at a time, results in order. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
	const out = Array.from<R>({ length: items.length });
	let i = 0;
	const worker = async () => {
		while (i < items.length) {
			const at = i++;
			out[at] = await fn(items[at], at);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

/** Writes through a temp file, so a crash never leaves half a file under the real name. */
async function writeAtomic(file: string, data: string | Buffer) {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(`${file}.tmp`, data);
	await rename(`${file}.tmp`, file);
}

const exists = async (file: string) => {
	try {
		await stat(file);
		return true;
	} catch {
		return false;
	}
};

/** One page to make thumbnails for. */
export interface PageJob {
	id: string;
	path: string;
	stamp: string;
	/** The overview, relative to the print's render folder. */
	overview: string;
}

/** What a print needs: pages whose thumbnails are up to date (kept) and pages to make. */
export interface PrintPlan {
	id: string;
	/** Book paths in index.json's order. */
	order: string[];
	kept: Record<string, ThumbPage>;
	jobs: PageJob[];
	/** thumbs.json must be written: pages to make, a page gone, or no thumbs.json yet. */
	rewrite: boolean;
}

const readJson = async <T>(file: string): Promise<T | null> => {
	try {
		return JSON.parse(await readFile(file, 'utf8')) as T;
	} catch {
		return null;
	}
};

/**
 * Compare the print's rendered pages (its index.json) with its thumbs.json: a page is kept when it
 * lists the same stamp and the tiers its size calls for, and every file is there. Null when the print
 * has no render.
 */
export async function planPrint(rendersDir: string, outDir: string, id: string, force = false): Promise<PrintPlan | null> {
	const index = await readJson<RenderIndex>(join(rendersDir, id, 'index.json'));
	if (index?.v !== 2) return null;
	const prev = force ? null : await readJson<ThumbsIndex>(join(outDir, id, THUMBS_INDEX));
	const plan: PrintPlan = { id, order: Object.keys(index.pages), kept: {}, jobs: [], rewrite: false };
	for (const [path, { stamp, overview }] of Object.entries(index.pages)) {
		const old = prev?.v === 1 ? prev.pages[path] : undefined;
		const want = old && old.stamp === stamp ? thumbTiers(old.w, old.h) : null;
		if (
			old &&
			want &&
			want.join() === old.sizes.join() &&
			(await Promise.all(want.map((t) => exists(join(outDir, id, thumbFile(path, stamp, t)))))).every(Boolean)
		)
			plan.kept[path] = old;
		else plan.jobs.push({ id, path, stamp, overview });
	}
	plan.rewrite = plan.jobs.length > 0 || prev?.v !== 1 || Object.keys(prev.pages).length !== Object.keys(plan.kept).length;
	return plan;
}

/** Whether the print has a thumbs.json listing any page (e.g. left from before its render went). */
export const hasThumbs = async (outDir: string, id: string) =>
	Object.keys((await readJson<ThumbsIndex>(join(outDir, id, THUMBS_INDEX)))?.pages ?? {}).length > 0;

export interface PageResult {
	page: ThumbPage;
	/** Bytes per tier made. */
	bytes: Record<number, number>;
	/** Decode plus encodes, on one thread. */
	ms: number;
	/** The last tier was made at the overview's own size (it can't fill that tier's box). */
	clamped: boolean;
}

/** Decode one page's overview and write its thumbnails; null when the overview is missing. */
export async function makePage(
	rendersDir: string,
	outDir: string,
	job: PageJob,
	enc: { quality: number; effort: number } = THUMB
): Promise<PageResult | null> {
	const file = join(rendersDir, job.id, job.overview);
	if (!(await exists(file))) return null;
	const img = await decodeOverview(file);
	let ms = img.ms;
	const sizes = thumbTiers(img.width, img.height);
	const bytes: Record<number, number> = {};
	for (const tier of sizes) {
		const out = await encodeThumb(img, tier, enc);
		ms += out.ms;
		bytes[tier] = out.data.length;
		await writeAtomic(join(outDir, job.id, thumbFile(job.path, job.stamp, tier)), out.data);
	}
	return {
		page: { stamp: job.stamp, w: img.width, h: img.height, sizes },
		bytes,
		ms,
		clamped: thumbSize(img.width, img.height, sizes.at(-1)!).scale >= 1
	};
}

/** Every file under `dir`, relative to it. */
async function walk(dir: string, rel = ''): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(join(dir, rel), { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const e of entries) {
		const name = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) out.push(...(await walk(dir, name)));
		else out.push(name);
	}
	return out;
}

/**
 * Write the print's thumbs.json (pages in index.json's order) and delete its thumbnails no page
 * lists any more (older stamps, removed pages) and leftover temp files. Returns how many went.
 */
export async function finishPrint(outDir: string, id: string, order: string[], pages: Record<string, ThumbPage>): Promise<number> {
	const index: ThumbsIndex = { v: 1, pages: {} };
	for (const path of order) if (pages[path]) index.pages[path] = pages[path];
	await writeAtomic(join(outDir, id, THUMBS_INDEX), JSON.stringify(index));
	const wanted = new Set(Object.entries(index.pages).flatMap(([path, p]) => p.sizes.map((t) => thumbFile(path, p.stamp, t))));
	let removed = 0;
	for (const f of await walk(join(outDir, id))) {
		if ((THUMB_FILE.test(f) && !wanted.has(f)) || f.endsWith('.tmp')) {
			await rm(join(outDir, id, f), { force: true });
			removed++;
		}
	}
	return removed;
}
