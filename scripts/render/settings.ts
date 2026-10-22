/**
 * What decides a render's pixels and files, shared by the runner and its workers. Anything that
 * changes the output belongs in `renderSettings` or RENDER_SETTINGS_VERSION, so that it changes
 * every page's input key and the next run redoes them.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TILE_PX } from '#lib/viewer/game-render.js';

export const ROOT = join(import.meta.dirname, '..', '..');
export const OUT_DIR = join(ROOT, 'data', 'renders');

/** Bump when the drawing or file layout changes in a way the settings below don't capture. */
export const RENDER_SETTINGS_VERSION = 1;

/** Overview images fit in this many pixels on the long edge. */
export const OVERVIEW_MAX = 2048;
/** 64 px/tile is the 2x atlases' native resolution; more adds no detail. */
export const MAX_PPT = 64;
/** Tile levels; a page gets every one sharper than its overview. */
export const LEVELS = [16, 32, 64] as const;
/** Paint 4×4 output tiles per fpsr call, plus a bleed (world tiles) so shadows match across seams. */
export const CHUNK_TILES = 4;
export const BLEED = 2;
export const ALT_MODE = true;
export const AVIF = { quality: 65, effort: 1, chromaSubsampling: '4:4:4' } as const;

export const renderSettings = {
	v: RENDER_SETTINGS_VERSION,
	overviewMax: OVERVIEW_MAX,
	maxPpt: MAX_PPT,
	levels: LEVELS,
	tile: TILE_PX,
	chunk: CHUNK_TILES,
	bleed: BLEED,
	altMode: ALT_MODE,
	avif: AVIF
};

export interface AssetInfo {
	dir: string;
	/** `<game version>/<first 12 hex of the 2x render db's sha256>`. */
	id: string;
	gameVersion: string;
	fpsr: string;
}

/** The fpsr asset bundle in FPSR_ASSETS_DIR (required), or an error message. */
export async function loadAssetInfo(): Promise<AssetInfo | string> {
	const set = process.env.FPSR_ASSETS_DIR;
	if (!set) {
		return (
			'FPSR_ASSETS_DIR is not set. Point it at an fpsr asset bundle built from an installed Factorio: ' +
			"the `assets-out/<game version>` folder that fpsr's `pnpm assets:build` writes."
		);
	}
	const dir = resolve(set);
	const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8').catch(() => 'null')) as {
		schema: number;
		gameVersion: string;
		tiers: { '2x': { renderDb: { sha256: string } } };
	} | null;
	if (manifest?.schema !== 2) return `FPSR_ASSETS_DIR=${set}: no schema-2 fpsr asset bundle (manifest.json) in ${dir}.`;
	const pkg = JSON.parse(await readFile(join(ROOT, 'node_modules/@rickyzhangca/fpsr/package.json'), 'utf8')) as { version: string };
	return {
		dir,
		id: `${manifest.gameVersion}/${manifest.tiers['2x'].renderDb.sha256.slice(0, 12)}`,
		gameVersion: manifest.gameVersion,
		fpsr: pkg.version
	};
}

/** sha256 of the page's blueprint JSON as rendered, the assets, fpsr and the render settings. */
export const inputKey = (pageJson: string, assets: Pick<AssetInfo, 'id' | 'fpsr'>) =>
	createHash('sha256')
		.update(JSON.stringify({ assets: assets.id, fpsr: assets.fpsr, settings: renderSettings }))
		.update('\n')
		.update(pageJson)
		.digest('hex');

/** Prefix of every tile hash, so a change of encoder settings never reuses a tile encoded the old way. */
export const TILE_HASH_SALT = `avif q${AVIF.quality} e${AVIF.effort} ${AVIF.chromaSubsampling}\n`;
