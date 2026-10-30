/**
 * The local record store: every print record this machine has from a site other than factorioprints
 * (whose records stay in the mirror clone), one SourceRecord (src/lib/server/pipeline/source-record.ts)
 * per file, so the offline steps (render, thumbnails) read any site's prints the same way.
 *
 *   <RECORDS_DIR>/<site>/<siteId>.json     the record, as SourceRecord JSON
 *   <RECORDS_DIR>/<site>/.index.json       { v: 1, records: { <siteId>: { rev, firstSeen, fetchedAt } } }
 *
 * RECORDS_DIR (e.g. in .env), else ~/data/factorio-records, beside the mirror clone; never inside the
 * repo (records are players' work). `bun run records` fills it (scripts/records.ts, the update's fetch
 * step): each site's adapter lists its records with a revision (`rev`), and only new or changed ones
 * are fetched. A record file is rewritten only when its text changes, so its size and mtime (the render
 * queue's stamp, render_prints.stamp) move only with the record.
 *
 * Node only.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { printIdFor, siteOfPrintId, SITE_PREFIX, SITES, type Site } from '#lib/print-id.js';
import type { SourceRecord } from '#lib/server/pipeline/source-record.js';

/** Sites whose records live in the store: every site but factorioprints (the mirror clone). */
export type StoreSite = Exclude<Site, 'factorioprints'>;
export const STORE_SITES = SITES.filter((s): s is StoreSite => s !== 'factorioprints');

/** RECORDS_DIR (`~/` expanded, relative to `root`), else ~/data/factorio-records. */
export const recordsDir = (root = process.cwd(), value = process.env.RECORDS_DIR) => {
	const dir = value?.trim();
	if (!dir) return join(homedir(), 'data', 'factorio-records');
	return resolve(root, dir === '~' || dir.startsWith('~/') ? join(homedir(), dir.slice(1)) : dir);
};

export interface StoreEntry {
	/** The site's revision of the record when it was fetched (an upload: `<updated_at>:<shown name>`). */
	rev: string;
	/** Unix ms: when this machine first had it (for a later `--newest N`). */
	firstSeen: number;
	fetchedAt: number;
}

export interface StoreIndex {
	v: 1;
	records: Record<string, StoreEntry>;
}

const INDEX = '.index.json';

/** A site's id as a file name: only ids that make a print id (no path tricks). */
const checkedSiteId = (site: StoreSite, siteId: string) => {
	printIdFor(site, siteId);
	return siteId;
};

export const recordFile = (dir: string, site: StoreSite, siteId: string) => join(dir, site, `${checkedSiteId(site, siteId)}.json`);

/** The store file of a print id, or null for a factorioprints id (or no print id at all). */
export const storeFileOf = (dir: string, printId: string) => {
	const site = siteOfPrintId(printId);
	if (!site || site === 'factorioprints') return null;
	return recordFile(dir, site, printId.slice(SITE_PREFIX[site].length + 1));
};

/** Temp file + rename, so a reader never sees half a file. */
let tmpCount = 0;
const writeAtomic = async (file: string, text: string) => {
	const tmp = `${file}.${process.pid}-${++tmpCount}.tmp`;
	await writeFile(tmp, text);
	await rename(tmp, file);
};

export async function readIndex(dir: string, site: StoreSite): Promise<StoreIndex> {
	try {
		const index = JSON.parse(await readFile(join(dir, site, INDEX), 'utf8')) as StoreIndex;
		if (index.v === 1 && index.records && typeof index.records === 'object') return index;
	} catch {
		// Missing or unreadable: rebuilt from the listing (every record fetched once again).
	}
	return { v: 1, records: {} };
}

export async function writeIndex(dir: string, site: StoreSite, index: StoreIndex) {
	await mkdir(join(dir, site), { recursive: true });
	await writeAtomic(join(dir, site, INDEX), JSON.stringify(index));
}

/** The record as stored. Throws unless it is a store site's record whose id makes a print id. */
export const recordText = (r: SourceRecord) => {
	if (r.site === 'factorioprints') throw new Error('factorioprints records stay in the mirror clone');
	checkedSiteId(r.site, r.siteId);
	const { native: _native, ...rest } = r;
	return `${JSON.stringify(rest)}\n`;
};

/** Writes the record unless the file already holds the same text. Returns whether it wrote. */
export async function putRecord(dir: string, r: SourceRecord): Promise<boolean> {
	const text = recordText(r);
	const file = recordFile(dir, r.site as StoreSite, r.siteId);
	if (existsSync(file) && (await readFile(file, 'utf8')) === text) return false;
	await mkdir(join(dir, r.site), { recursive: true });
	await writeAtomic(file, text);
	return true;
}

export const dropRecord = (dir: string, site: StoreSite, siteId: string) => rm(recordFile(dir, site, siteId), { force: true });

export async function readStoreRecord(dir: string, printId: string): Promise<SourceRecord | null> {
	const file = storeFileOf(dir, printId);
	if (!file) return null;
	try {
		return JSON.parse(await readFile(file, 'utf8')) as SourceRecord;
	} catch {
		return null;
	}
}

/** Every print id the store has a record for, by site in SITES order, then by id. */
export async function storePrintIds(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const site of STORE_SITES) {
		let files: string[];
		try {
			files = await readdir(join(dir, site));
		} catch {
			continue;
		}
		const ids: string[] = [];
		for (const f of files) {
			if (!f.endsWith('.json') || f.startsWith('.')) continue;
			try {
				ids.push(printIdFor(site, f.slice(0, -5)));
			} catch {
				// Not a record of this site: left alone.
			}
		}
		out.push(...ids.sort());
	}
	return out;
}
