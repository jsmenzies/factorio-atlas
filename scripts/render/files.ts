/**
 * The runner's own file work under <renders dir>/<id>/ (RENDERS_DIR, else data/renders): index.json (from render_jobs), reading a
 * page's sidecar back, the page data of pages rendered before it existed, removing pages a print no
 * longer has, and deleting tiles and overviews no sidecar uses.
 */
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
	overviewFile,
	PAGE_DATA_VERSION,
	pageDataFile,
	sidecarFile,
	TILE_HASH,
	type RenderIndex,
	type RenderSidecar
} from '#lib/viewer/game-render.js';
import { pageDataJson, writeAtomic } from './draw.js';

/** Book order: "" first, then by each index number ("2" < "10", "3" < "3/1"). */
export const comparePaths = (a: string, b: string) => {
	const pa = a ? a.split('/').map(Number) : [];
	const pb = b ? b.split('/').map(Number) : [];
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		if (pa[i] === undefined) return -1;
		if (pb[i] === undefined) return 1;
		if (pa[i] !== pb[i]) return pa[i] - pb[i];
	}
	return 0;
};

export async function readSidecar(outDir: string, id: string, path: string): Promise<RenderSidecar | null> {
	try {
		const sc = JSON.parse(await readFile(join(outDir, id, sidecarFile(path)), 'utf8')) as RenderSidecar;
		return sc.v === 2 ? sc : null;
	} catch {
		return null;
	}
}

type IndexPage = { path: string; stamp: string | null; overview: string | null };

/** index.json for these pages (those with a stamp), in book order; null when there are none. */
export function buildIndex(done: IndexPage[]): RenderIndex | null {
	const pages = done.filter((d) => d.stamp).sort((a, b) => comparePaths(a.path, b.path));
	if (!pages.length) return null;
	return {
		v: 2,
		cover: pages[0].path,
		pages: Object.fromEntries(pages.map((p) => [p.path, { stamp: p.stamp!, overview: p.overview ?? overviewFile(p.path, p.stamp!) }]))
	};
}

/** index.json for the pages listed (done rows of render_jobs); removed when there are none. */
export async function writeIndex(outDir: string, id: string, done: IndexPage[]) {
	const file = join(outDir, id, 'index.json');
	const index = buildIndex(done);
	if (!index) await rm(file, { force: true });
	else await writeAtomic(file, JSON.stringify(index));
}

/**
 * Give a page rendered before page data existed (or with an older PAGE_DATA_VERSION) its page
 * data, without redrawing: the data file, then the sidecar marked with the version. Only for
 * pages no worker is rendering. Returns the bytes written.
 */
export async function writePageData(outDir: string, id: string, sc: RenderSidecar, pageJson: string) {
	const bytes = await writeAtomic(join(outDir, id, pageDataFile(sc.path)), pageDataJson(pageJson, sc.stamp));
	await writeAtomic(join(outDir, id, sidecarFile(sc.path)), JSON.stringify({ ...sc, pageData: PAGE_DATA_VERSION } satisfies RenderSidecar));
	return bytes;
}

/** An overview file in a print's folder or a book folder: `<base>.<stamp>.avif`. */
const OVERVIEW_NAME = /^(?:root|\d+)\.[0-9a-f]{10}\.avif$/;

/** A page the print no longer has: its overviews, page data and sidecar go (its tiles go with the next sweep). */
export async function removePage(outDir: string, id: string, path: string) {
	await Promise.all([pageDataFile(path), sidecarFile(path)].map((f) => rm(join(outDir, id, f), { force: true })));
	const base = sidecarFile(path).slice(0, -'.json'.length);
	const dir = join(outDir, id, dirname(base));
	const name = base.split('/').at(-1)!;
	let files: string[] = [];
	try {
		files = await readdir(dir);
	} catch {
		return;
	}
	for (const f of files) if (OVERVIEW_NAME.test(f) && f.startsWith(`${name}.`)) await rm(join(dir, f), { force: true });
}

/**
 * Every sidecar of a print (any depth, so book paths like 3/1 are found), and every overview file
 * (relative paths). Deletes temp files left by a crash on the way.
 */
async function sidecars(dir: string, rel = '', overviews: string[] = []): Promise<RenderSidecar[]> {
	const out: RenderSidecar[] = [];
	let entries;
	try {
		entries = await readdir(join(dir, rel), { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const name = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory() && /^\d+$/.test(e.name)) out.push(...(await sidecars(dir, name, overviews)));
		else if (e.isFile() && e.name.endsWith('.tmp')) await rm(join(dir, name), { force: true });
		else if (e.isFile() && OVERVIEW_NAME.test(e.name)) overviews.push(name);
		else if (e.isFile() && e.name.endsWith('.json') && !e.name.endsWith('.page.json') && name !== 'index.json') {
			try {
				const sc = JSON.parse(await readFile(join(dir, name), 'utf8')) as RenderSidecar;
				if (sc.v === 2) out.push(sc);
			} catch {
				// A sidecar that doesn't parse keeps nothing alive.
			}
		}
	}
	return out;
}

/**
 * Delete tiles and overviews no sidecar of the print refers to (an older render's), and leftover
 * temp files. Only safe while no page of the print is being rendered (a new tile and overview are
 * written before their sidecar).
 */
export async function sweepTiles(
	outDir: string,
	id: string
): Promise<{ removed: number; tiles: number; overviews: number; bytes: number }> {
	const dir = join(outDir, id);
	const used = new Set<string>();
	const overviews: string[] = [];
	const usedOverviews = new Set<string>();
	for (const sc of await sidecars(dir, '', overviews)) {
		usedOverviews.add(sc.overview.file);
		for (const l of sc.levels) for (const t of l.tiles) if (t) used.add(t);
	}
	let tiles = 0;
	let overviewsRemoved = 0;
	let bytes = 0;
	const remove = async (path: string) => {
		try {
			bytes += (await stat(path)).size;
		} catch {
			// gone already
		}
		await rm(path, { force: true });
	};
	for (const o of overviews) {
		if (usedOverviews.has(o)) continue;
		await remove(join(dir, o));
		overviewsRemoved++;
	}
	const result = () => ({ removed: tiles + overviewsRemoved, tiles, overviews: overviewsRemoved, bytes });
	let files: string[];
	try {
		files = await readdir(join(dir, 't'));
	} catch {
		return result();
	}
	for (const f of files) {
		const hash = f.endsWith('.avif') ? f.slice(0, -5) : '';
		if (TILE_HASH.test(hash) && used.has(hash)) continue;
		await remove(join(dir, 't', f));
		tiles++;
	}
	return result();
}
