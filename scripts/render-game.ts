/**
 * Offline game-look renders with fpsr. Reads raw records from data/raw/factorioprints (saved there
 * by `bun run ingest`; gitignored), renders every blueprint page to WebP and writes a JSON sidecar
 * the viewer aligns with.
 *
 *   bun run render --from-disk [dir]        # every record in data/raw/factorioprints
 *   bun run render <id> [<id> ...]          # specific prints (still read from disk)
 *   bun run render <id> --page 3/1          # one book page (path as in print_nodes.path)
 *     --force      re-render pages that already have a sidecar
 *     --stale      re-render pages drawn by a different asset set (e.g. placeholders)
 *     --no-upload  write data/renders only, skip the local R2 bucket
 *
 * Assets: FPSR_ASSETS_DIR (an fpsr `assets-out/<version>` folder), defaulting to the
 * placeholder bundle from `bun scripts/fpsr-placeholder-assets.ts`.
 *
 * Output: data/renders/<id>/<path or "root">.webp|.json, `.tiles/<ppt>/<col>-<row>.webp`
 * for big pages, and <id>/index.json. Also uploaded to the RENDERS bucket through
 * getPlatformProxy, the same local state `vite dev` uses. Renders from real sprites derive
 * from Wube's art: data/renders is gitignored and must stay that way.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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
import { Effect } from 'effect';
import { Canvas } from 'skia-canvas';
import { getPlatformProxy } from 'wrangler';
import { decodeExchangeString, OFFLINE_MAX_INFLATED_BYTES } from '#lib/server/pipeline/decode.js';
import { gameCatalog } from '#lib/viewer/catalog.server.js';
import { extractPage, listPages } from '#lib/viewer/extract.js';
import { pageBase, tileFile, TILE_PX, type RenderIndex, type RenderLevel, type RenderSidecar } from '#lib/viewer/game-render.js';

const ROOT = join(import.meta.dirname, '..');
const RAW_DIR = join(ROOT, 'data', 'raw', 'factorioprints');
const OUT_DIR = join(ROOT, 'data', 'renders');
const ASSETS_DIR = resolve(process.env.FPSR_ASSETS_DIR ?? join(ROOT, '.cache', 'fpsr-placeholder', '2.1.11'));

/** Overview images fit in this many pixels on the long edge. */
const OVERVIEW_MAX = 2048;
/** 64 px/tile is the 2x atlases' native resolution; more adds no detail. */
const MAX_PPT = 64;
const LEVELS = [16, 32, 64];
/** Paint 4×4 output tiles per fpsr call, plus a bleed so shadows match across seams. */
const CHUNK_TILES = 4;
const BLEED = 2;
const WEBP_QUALITY = 0.82;
const ALT_MODE = true;
const BACKGROUND: RenderBackground = { type: 'none' };

type Json = Record<string, unknown>;

// --- args

const argv = process.argv.slice(2);
const flag = (name: string) => {
	const i = argv.indexOf(name);
	if (i < 0) return false;
	argv.splice(i, 1);
	return true;
};
const option = (name: string) => {
	const i = argv.indexOf(name);
	if (i < 0) return undefined;
	const [, value] = argv.splice(i, 2);
	if (value === undefined) throw new Error(`${name} needs a value`);
	return value;
};
const force = flag('--force');
const stale = flag('--stale');
const upload = !flag('--no-upload');
const onlyPage = option('--page');
const fromDisk = flag('--from-disk');
let rawDir = RAW_DIR;
if (fromDisk && argv[0]) rawDir = resolve(argv.shift()!);
const ids = fromDisk ? (await readdir(rawDir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : argv;
if (!ids.length) {
	console.error('usage: render --from-disk [dir] | <id>... [--page <path>] [--force] [--stale] [--no-upload]');
	process.exit(1);
}

// --- assets

const manifest = JSON.parse(await readFile(join(ASSETS_DIR, 'manifest.json'), 'utf8').catch(() => 'null')) as {
	schema: number;
	gameVersion: string;
	placeholder?: boolean;
	tiers: { '2x': { renderDb: { sha256: string } } };
} | null;
if (manifest?.schema !== 2) {
	console.error(`No schema-2 fpsr bundle in ${ASSETS_DIR}. Run \`bun scripts/fpsr-placeholder-assets.ts\` or set FPSR_ASSETS_DIR.`);
	process.exit(1);
}
const assets = {
	id: `${manifest.gameVersion}/${manifest.tiers['2x'].renderDb.sha256.slice(0, 12)}`,
	gameVersion: manifest.gameVersion,
	placeholder: manifest.placeholder === true
};
const fpsrVersion = (JSON.parse(await readFile(join(ROOT, 'node_modules/@rickyzhangca/fpsr/package.json'), 'utf8')) as { version: string })
	.version;

const source = localAssets(ASSETS_DIR);
const db: RenderDb = await source.loadRenderDb('2x');
const renderer: Renderer = await createRenderer({
	assets: source,
	renderDb: db,
	createCanvas: (w, h) => new Canvas(w, h) as unknown as CanvasLike
});
const catalog = gameCatalog();
const proxy = upload ? await getPlatformProxy<Env>({ persist: true }) : null;

console.log(`assets ${assets.id}${assets.placeholder ? ' (placeholder sprites)' : ''} from ${ASSETS_DIR}, fpsr ${fpsrVersion}`);

// --- helpers

const CONTENT_TYPES: Record<string, string> = { webp: 'image/webp', json: 'application/json' };

async function put(key: string, body: Uint8Array | string) {
	const path = join(OUT_DIR, key);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, body);
	await proxy?.env.RENDERS.put(key, body, { httpMetadata: { contentType: CONTENT_TYPES[key.split('.').pop()!] } });
	return typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength;
}

const readJson = async <T>(path: string): Promise<T | null> => {
	try {
		return JSON.parse(await readFile(path, 'utf8')) as T;
	} catch {
		return null;
	}
};

/** The blueprint body at a book path, with the nearest `version` filled in (fpsr migrates 1.x by it). */
function blueprintAt(decoded: Json, path: string): Json | null {
	let node = decoded;
	let version: unknown;
	for (const step of path ? path.split('/').map(Number) : []) {
		const book = node.blueprint_book as Json | undefined;
		if (!book) return null;
		version = book.version ?? version;
		const child = ((book.blueprints ?? []) as Json[]).find((c) => (typeof c.index === 'number' ? c.index : 0) === step);
		if (!child) return null;
		node = child;
	}
	const bp = node.blueprint as Json | undefined;
	if (!bp) return null;
	return { ...bp, version: bp.version ?? version };
}

/** Move entities by the viewer's half-tile fix (0.15-0.18 exports) so both share one world. */
const shifted = (bp: Json, [sx, sy]: [number, number]): Json =>
	!sx && !sy
		? bp
		: {
				...bp,
				entities: ((bp.entities ?? []) as Json[]).map((e) => {
					const p = e.position as { x: number; y: number };
					return { ...e, position: { x: p.x + sx, y: p.y + sy } };
				})
			};

const encode = (canvas: CanvasLike) => (canvas as unknown as Canvas).toBuffer('webp', { quality: WEBP_QUALITY });

async function renderPage(id: string, decoded: Json, path: string): Promise<RenderSidecar | 'skip' | null> {
	const base = pageBase(path);
	const sidecarPath = join(OUT_DIR, id, `${base}.json`);
	const old = await readJson<RenderSidecar>(sidecarPath);
	if (old && !force && !(stale && old.assets.id !== assets.id)) return 'skip';

	const page = extractPage(decoded, path, catalog);
	const raw = blueprintAt(decoded, path);
	if (!page || !raw) return null;
	if (!page.entities.length && !page.tiles.length) return null;
	const offset = page.offset ?? [0, 0];
	const bp = shifted(raw, offset) as unknown as Blueprint;

	const t0 = performance.now();
	const unknown: Record<string, number> = {};
	for (const e of migrateTo2x(bp).entities ?? []) if (!db.entities[e.name]) unknown[e.name] = (unknown[e.name] ?? 0) + 1;

	const drawList = planDrawList(bp, db, { altMode: ALT_MODE });
	const frame = renderer.measure(bp, { altMode: ALT_MODE }).tileFrame;
	const tilesW = frame.maxX - frame.minX;
	const tilesH = frame.maxY - frame.minY;
	const long = Math.max(tilesW, tilesH);
	const ppt = long * MAX_PPT <= OVERVIEW_MAX ? MAX_PPT : long <= OVERVIEW_MAX ? Math.floor(OVERVIEW_MAX / long) : OVERVIEW_MAX / long;

	await rm(join(OUT_DIR, id, `${base}.tiles`), { recursive: true, force: true });
	let bytes = 0;
	let files = 0;
	const overview = await renderer.render(bp, { pixelsPerTile: ppt, altMode: ALT_MODE, background: BACKGROUND });
	bytes += await put(`${id}/${base}.webp`, await encode(overview.canvas));
	files++;

	const levels: RenderLevel[] = [];
	for (const lp of LEVELS.filter((l) => l >= ppt * 1.5)) {
		const level: RenderLevel = { ppt: lp, width: tilesW * lp, height: tilesH * lp, cols: 0, rows: 0 };
		level.cols = Math.ceil(level.width / TILE_PX);
		level.rows = Math.ceil(level.height / TILE_PX);
		const span = TILE_PX / lp; // world tiles per output tile, a whole number for these levels
		for (let cr = 0; cr < level.rows; cr += CHUNK_TILES) {
			for (let cc = 0; cc < level.cols; cc += CHUNK_TILES) {
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
				for (let r = cr; r < Math.min(level.rows, cr + CHUNK_TILES); r++) {
					for (let c = cc; c < Math.min(level.cols, cc + CHUNK_TILES); c++) {
						const w = Math.min(TILE_PX, level.width - c * TILE_PX);
						const h = Math.min(TILE_PX, level.height - r * TILE_PX);
						const sx = (frame.minX + c * span - region.minX) * lp;
						const sy = (frame.minY + r * span - region.minY) * lp;
						const tile = new Canvas(w, h);
						tile.getContext('2d').drawImage(chunk.canvas as unknown as Canvas, sx, sy, w, h, 0, 0, w, h);
						bytes += await put(`${id}/${tileFile({ path }, lp, c, r)}`, await tile.toBuffer('webp', { quality: WEBP_QUALITY }));
						files++;
					}
				}
			}
		}
		levels.push(level);
	}

	const renderedAt = new Date().toISOString();
	const sidecar: RenderSidecar = {
		v: 1,
		id,
		path,
		assets,
		fpsr: fpsrVersion,
		stamp: createHash('sha256').update(`${assets.id}:${renderedAt}`).digest('hex').slice(0, 10),
		renderedAt,
		frame,
		offset,
		overview: { width: overview.width, height: overview.height, ppt },
		tile: TILE_PX,
		levels,
		altMode: ALT_MODE,
		stats: { entities: page.entities.length, unknown, ms: Math.round(performance.now() - t0), bytes, files: files + 1 }
	};
	// Sidecar last: a crash mid-page leaves no sidecar, so the page is redone next run.
	await put(`${id}/${base}.json`, JSON.stringify(sidecar));
	return sidecar;
}

// --- main

const rows: string[] = [];
let failed = 0;
try {
	for (const id of ids) {
		const record = await readJson<{ blueprintString?: string }>(join(rawDir, `${id}.json`));
		if (!record?.blueprintString) {
			console.error(`${id}: no record in ${rawDir}`);
			failed++;
			continue;
		}
		const decoded = (await Effect.runPromise(
			decodeExchangeString(record.blueprintString, { maxInflatedBytes: OFFLINE_MAX_INFLATED_BYTES })
		)) as Json;
		const pages = listPages(decoded).filter((p) => p.kind === 'blueprint' && (onlyPage === undefined || p.path === onlyPage));
		const indexPath = join(OUT_DIR, id, 'index.json');
		const index = (await readJson<RenderIndex>(indexPath)) ?? { v: 1, cover: null, pages: {} };
		const t0 = performance.now();
		let done = 0;
		let skipped = 0;
		let bytes = 0;
		for (const p of pages) {
			try {
				const sc = await renderPage(id, decoded, p.path);
				if (sc === 'skip') skipped++;
				else if (sc) {
					done++;
					bytes += sc.stats.bytes;
					index.pages[p.path] = { stamp: sc.stamp, placeholder: sc.assets.placeholder };
					const unknown = Object.entries(sc.stats.unknown);
					const levelInfo = sc.levels.map((l) => `${l.ppt}:${l.cols}×${l.rows}`).join(' ');
					console.log(
						`  ${id} ${pageBase(p.path).padEnd(6)} ${sc.stats.entities} ents ${sc.frame.maxX - sc.frame.minX}×${sc.frame.maxY - sc.frame.minY} tiles → ` +
							`${sc.overview.width}×${sc.overview.height}@${sc.overview.ppt}${levelInfo ? ` + ${levelInfo}` : ''}, ` +
							`${(sc.stats.bytes / 1024).toFixed(0)} KB, ${sc.stats.ms} ms` +
							(unknown.length ? `; not in render-db: ${unknown.map(([n, c]) => `${n}×${c}`).join(', ')}` : '')
					);
				}
			} catch (e) {
				failed++;
				console.error(`  ${id} ${pageBase(p.path)} failed:`, e instanceof Error ? e.message : e);
			}
		}
		if (done) {
			index.cover = listPages(decoded).find((p) => p.kind === 'blueprint' && index.pages[p.path])?.path ?? null;
			await put(`${id}/index.json`, JSON.stringify(index));
		}
		rows.push(
			`${id}: ${done} rendered, ${skipped} skipped of ${pages.length} pages, ${(bytes / 1024 / 1024).toFixed(2)} MB, ${((performance.now() - t0) / 1000).toFixed(1)} s`
		);
	}
} finally {
	await proxy?.dispose();
}
console.log(rows.join('\n'));
if (failed) process.exit(1);
