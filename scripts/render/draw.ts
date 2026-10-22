/**
 * Draws one blueprint page with fpsr and writes its files (layout in #lib/viewer/game-render.ts):
 * the overview (named by the render's stamp), every tile level sharper than it, the page data for hover tooltips, and the sidecar, last. Tiles are named by a hash
 * of their pixels and written once per print, so pages and levels share identical tiles (mostly
 * empty space) and a tile already on disk is not encoded again. Runs inside a render worker.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
	createRenderer,
	migrateTo2x,
	type Blueprint,
	type CanvasLike,
	type RenderBackground,
	type Renderer,
	type RenderDb
} from '@rickyzhangca/fpsr';
import { localAssets } from '@rickyzhangca/fpsr/node';
import { planDrawList } from '@rickyzhangca/fpsr/planner';
import { renderPreparedViewport } from '@rickyzhangca/fpsr/unstable-prepared-viewport';
import sharp from 'sharp';
import { Canvas } from 'skia-canvas';
import {
	levelsAbove,
	overviewFile,
	PAGE_DATA_VERSION,
	pageDataFile,
	sidecarFile,
	tileHashFile,
	TILE_PX,
	type RenderLevel,
	type RenderSidecar
} from '#lib/viewer/game-render.js';
import { occupancy } from './occupancy.js';
import { ALT_MODE, AVIF, BLEED, CHUNK_TILES, LEVELS, MAX_PPT, OVERVIEW_MAX, TILE_HASH_SALT, type AssetInfo } from './settings.js';

const BACKGROUND: RenderBackground = { type: 'none' };
/** A full GC every this many drawn chunks: about 2% of the time, and it keeps a worker's resident set flat. */
const GC_EVERY_CHUNKS = 16;
const collect = () => (globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc(true);

export interface PageJob {
	id: string;
	path: string;
	/** The page's blueprint JSON exactly as hashed into `inputKey`. */
	json: string;
	/** The page's CompactPage JSON (extractPage on the same decoded print), written as `<base>.page.json`. */
	page: string;
	inputKey: string;
	offset: [number, number];
	entities: number;
}

export interface PageResult {
	stamp: string;
	overview: string;
	files: number;
	bytes: number;
	ms: number;
	/** e.g. `260×132 tiles → 1820×924@7 + 16:9×5 32:17×9 64:33×17`. */
	summary: string;
	tiles: RenderSidecar['stats']['tiles'];
	time: NonNullable<RenderSidecar['stats']['time']>;
}

/**
 * Write via a temp file and rename, so a reader or a crash never sees half a file. The data is
 * flushed to disk before the rename: after a power cut a file is whole or absent, never empty, so a
 * sidecar (written last) never points at a tile that didn't make it.
 */
export async function writeAtomic(path: string, body: Uint8Array | string) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	const fh = await open(tmp, 'w');
	try {
		await fh.writeFile(body);
		await fh.sync();
	} finally {
		await fh.close();
	}
	await rename(tmp, path);
	return typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength;
}

/**
 * `<base>.page.json` as RenderPageData, from the page's CompactPage JSON (extractPage) and the
 * sidecar stamp it goes with. Built as text, so a big page isn't parsed again.
 */
export const pageDataJson = (pageJson: string, stamp: string) =>
	`{"v":${PAGE_DATA_VERSION},"stamp":${JSON.stringify(stamp)},"page":${pageJson}}`;

const encode = (data: Uint8ClampedArray, width: number, height: number) =>
	sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 4 } })
		.avif(AVIF)
		.toBuffer();

const rounded = <T extends Record<string, number>>(o: T) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)])) as T;

const transparent = (data: Uint8ClampedArray) => {
	// RGBA little-endian: alpha is each word's top byte.
	const words = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2);
	for (let i = 0; i < words.length; i++) if (words[i] & 0xff000000) return false;
	return true;
};

const tileHash = (data: Uint8ClampedArray, width: number, height: number) =>
	createHash('sha256').update(TILE_HASH_SALT).update(`${width}x${height}\n`).update(data).digest('hex').slice(0, 16);

const pixels = (canvas: CanvasLike, x: number, y: number, w: number, h: number) =>
	(canvas as unknown as Canvas).getContext('2d').getImageData(x, y, w, h).data;

/** A w×h rect at (sx, sy) out of RGBA pixels `stride` wide. */
const crop = (src: Uint8ClampedArray, stride: number, sx: number, sy: number, w: number, h: number) => {
	const out = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++) out.set(src.subarray(((sy + y) * stride + sx) * 4, ((sy + y) * stride + sx + w) * 4), y * w * 4);
	return out;
};

export interface PageRenderer {
	render(job: PageJob): Promise<PageResult>;
	/** AVIF encodes in flight at once; takes effect at once, also mid-page. */
	setEncodeParallel(n: number): void;
}

export interface PageRendererOptions {
	outDir: string;
	encodeParallel: number;
	/** Skip tiles the draw list can't reach (default true); false draws and reads every tile, to check the skipping. */
	skipEmpty?: boolean;
}

export async function createPageRenderer(assets: AssetInfo, opts: PageRendererOptions): Promise<PageRenderer> {
	const source = localAssets(assets.dir);
	const db: RenderDb = await source.loadRenderDb('2x');
	const renderer: Renderer = await createRenderer({
		assets: source,
		renderDb: db,
		createCanvas: (w, h) => new Canvas(w, h) as unknown as CanvasLike
	});
	let encodeParallel = opts.encodeParallel;
	/** Tiles this worker has written, per print: no need to ask the disk again. */
	const written = new Map<string, Set<string>>();

	return {
		setEncodeParallel(n) {
			encodeParallel = Math.max(1, Math.round(n));
		},
		async render(job) {
			const t0 = performance.now();
			const dir = join(opts.outDir, job.id);
			const bp = JSON.parse(job.json) as Blueprint;
			const unknown: Record<string, number> = {};
			for (const e of migrateTo2x(bp).entities ?? []) if (!db.entities[e.name]) unknown[e.name] = (unknown[e.name] ?? 0) + 1;

			const drawList = planDrawList(bp, db, { altMode: ALT_MODE });
			const frame = renderer.measure(bp, { altMode: ALT_MODE }).tileFrame;
			const occupied = opts.skipEmpty === false ? null : occupancy(drawList, frame);
			const tilesW = frame.maxX - frame.minX;
			const tilesH = frame.maxY - frame.minY;
			const long = Math.max(tilesW, tilesH);
			const ppt = long * MAX_PPT <= OVERVIEW_MAX ? MAX_PPT : long <= OVERVIEW_MAX ? Math.floor(OVERVIEW_MAX / long) : OVERVIEW_MAX / long;

			let bytes = 0;
			let files = 0;
			const time = { plan: 0, overview: 0, draw: 0, pixels: 0, encodeWait: 0 };
			let mark = t0;
			const lap = (k: keyof typeof time) => {
				const t = performance.now();
				time[k] += t - mark;
				mark = t;
			};
			lap('plan');
			const overview = await renderer.render(bp, { pixelsPerTile: ppt, altMode: ALT_MODE, background: BACKGROUND });
			// The stamp names the overview, so a re-render with other input writes a new file (cacheable for good).
			const stamp = job.inputKey.slice(0, 10);
			const ovFile = overviewFile(job.path, stamp);
			bytes += await writeAtomic(
				join(dir, ovFile),
				await encode(pixels(overview.canvas, 0, 0, overview.width, overview.height), overview.width, overview.height)
			);
			files++;
			lap('overview');

			if (!written.has(job.id)) {
				if (written.size > 8) written.clear();
				written.set(job.id, new Set());
			}
			const have = written.get(job.id)!;
			const tiles = { total: 0, empty: 0, reused: 0, written: 0, unread: 0 };
			// Encodes run while the next chunk draws; at most `encodeParallel` at once.
			const inflight = new Set<Promise<void>>();
			let failure: unknown = null;
			const queue = async (hash: string, data: Uint8ClampedArray, w: number, h: number) => {
				lap('pixels');
				while (inflight.size >= encodeParallel) await Promise.race(inflight);
				lap('encodeWait');
				const p = (async () => {
					const avif = await encode(data, w, h);
					// Not `bytes += await …`: that reads `bytes` before the await and loses concurrent writes.
					const n = await writeAtomic(join(dir, tileHashFile(hash)), avif);
					bytes += n;
					files++;
				})()
					.catch((e) => {
						failure ??= e;
					})
					.finally(() => inflight.delete(p));
				inflight.add(p);
			};

			const levels: RenderLevel[] = [];
			let drawn = 0;
			for (const lp of levelsAbove(ppt, LEVELS)) {
				const width = tilesW * lp;
				const height = tilesH * lp;
				const level: RenderLevel = {
					ppt: lp,
					width,
					height,
					cols: Math.ceil(width / TILE_PX),
					rows: Math.ceil(height / TILE_PX),
					tiles: []
				};
				level.tiles = Array.from({ length: level.cols * level.rows }, () => '');
				const span = TILE_PX / lp; // world tiles per output tile, a whole number for these levels
				for (let cr = 0; cr < level.rows; cr += CHUNK_TILES) {
					for (let cc = 0; cc < level.cols; cc += CHUNK_TILES) {
						// Tiles of this chunk that something can paint on; the rest stay transparent unread.
						const todo: [number, number][] = [];
						for (let r = cr; r < Math.min(level.rows, cr + CHUNK_TILES); r++) {
							for (let c = cc; c < Math.min(level.cols, cc + CHUNK_TILES); c++) {
								tiles.total++;
								const x = frame.minX + c * span;
								const y = frame.minY + r * span;
								if (!occupied || occupied.any(x, y, x + span, y + span)) todo.push([c, r]);
								else {
									tiles.empty++;
									tiles.unread++;
								}
							}
						}
						if (!todo.length) continue;
						const cx0 = frame.minX + cc * span;
						const cy0 = frame.minY + cr * span;
						const region = {
							minX: Math.max(frame.minX, cx0 - BLEED),
							minY: Math.max(frame.minY, cy0 - BLEED),
							maxX: Math.min(frame.maxX, cx0 + CHUNK_TILES * span + BLEED),
							maxY: Math.min(frame.maxY, cy0 + CHUNK_TILES * span + BLEED)
						};
						const chunk = await renderPreparedViewport(renderer, bp, {
							pixelsPerTile: lp,
							altMode: ALT_MODE,
							background: BACKGROUND,
							tileFrame: region,
							outputTileFrame: frame,
							preparedDrawList: drawList
						});
						lap('draw');
						// Chunk canvases hold native rasters the GC doesn't weigh; collect every few or RSS balloons.
						if (++drawn % GC_EVERY_CHUNKS === 0) collect();
						// One read per chunk: skia-canvas's getImageData costs about as much per call as per pixel.
						const all = pixels(chunk.canvas, 0, 0, chunk.width, chunk.height);
						for (const [c, r] of todo) {
							const w = Math.min(TILE_PX, width - c * TILE_PX);
							const h = Math.min(TILE_PX, height - r * TILE_PX);
							const sx = (frame.minX + c * span - region.minX) * lp;
							const sy = (frame.minY + r * span - region.minY) * lp;
							const data = crop(all, chunk.width, sx, sy, w, h);
							if (transparent(data)) {
								tiles.empty++;
								continue;
							}
							const hash = tileHash(data, w, h);
							level.tiles[r * level.cols + c] = hash;
							if (have.has(hash) || existsSync(join(dir, tileHashFile(hash)))) {
								tiles.reused++;
								have.add(hash);
								continue;
							}
							have.add(hash);
							tiles.written++;
							await queue(hash, data, w, h);
						}
						lap('pixels');
						// Let timers and IPC run (the worker's watchdog, messages): without encodes to wait on,
						// a page is one long chain of microtasks.
						await new Promise((resolve) => setImmediate(resolve));
						if (failure) break;
					}
					if (failure) break;
				}
				levels.push(level);
			}
			await Promise.all(inflight);
			lap('encodeWait');
			if (failure) {
				// Hashes in `have` whose write failed would be wrongly trusted later.
				written.delete(job.id);
				throw failure;
			}

			// The page data before the sidecar, so a sidecar never points at data that isn't there yet.
			bytes += await writeAtomic(join(dir, pageDataFile(job.path)), pageDataJson(job.page, stamp));
			files++;

			const sidecar: RenderSidecar = {
				v: 2,
				id: job.id,
				path: job.path,
				inputKey: job.inputKey,
				assets: { id: assets.id, gameVersion: assets.gameVersion },
				fpsr: assets.fpsr,
				stamp,
				renderedAt: new Date().toISOString(),
				frame,
				offset: job.offset,
				overview: { file: ovFile, width: overview.width, height: overview.height, ppt },
				tile: TILE_PX,
				levels,
				altMode: ALT_MODE,
				encoding: { format: 'avif', quality: AVIF.quality, effort: AVIF.effort, chroma: AVIF.chromaSubsampling },
				pageData: PAGE_DATA_VERSION,
				stats: {
					entities: job.entities,
					unknown,
					ms: Math.round(performance.now() - t0),
					bytes,
					files: files + 1,
					tiles,
					time: rounded(time)
				}
			};
			// Sidecar last: a crash mid-page leaves the old sidecar (or none), so the page is redone.
			bytes += await writeAtomic(join(dir, sidecarFile(job.path)), JSON.stringify(sidecar));
			const levelInfo = levels.map((l) => `${l.ppt}:${l.cols}×${l.rows}`).join(' ');
			return {
				stamp: sidecar.stamp,
				overview: ovFile,
				files: files + 1,
				bytes,
				ms: sidecar.stats.ms,
				summary: `${tilesW}×${tilesH} tiles → ${overview.width}×${overview.height}@${+ppt.toFixed(2)}${levelInfo ? ` + ${levelInfo}` : ''}`,
				tiles,
				time: sidecar.stats.time!
			};
		}
	};
}
