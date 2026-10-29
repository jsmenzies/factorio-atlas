/**
 * Which Imgur images the prints use: `image.id` and `image.type` from every record in a mirror
 * clone, plus a flat folder of raw records (`--from-disk`, e.g. data/raw/factorioprints) for prints
 * the clone lacks. Never Firebase. Shared images (one Imgur id on several prints) become one entry.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isFactorioprintsId } from '#lib/print-id.js';
import { listClone } from '#lib/server/pipeline/mirror-clone.js';
import type { Wanted } from './state.js';

/** Imgur ids seen in the mirror are 7 or 8 letters and digits. */
export const IMGUR_ID = /^[A-Za-z0-9]{5,10}$/;

/** A record's image, or null when it has none (or an id that isn't an Imgur id). */
export const imageOf = (record: unknown): { id: string; type: string | null } | null => {
	const image = (record as { image?: { id?: unknown; type?: unknown } } | null)?.image;
	if (typeof image?.id !== 'string' || !IMGUR_ID.test(image.id)) return null;
	return { id: image.id, type: typeof image.type === 'string' ? image.type : null };
};

export interface PrintImage {
	print: string;
	image: { id: string; type: string | null } | null;
}

/** One entry per Imgur id, in first-seen order, with every print that uses it. */
export function collect(records: Iterable<PrintImage>): { wanted: Wanted[]; noImage: string[] } {
	const byId = new Map<string, Wanted>();
	const noImage: string[] = [];
	for (const { print, image } of records) {
		if (!image) {
			noImage.push(print);
			continue;
		}
		const w = byId.get(image.id);
		if (w) {
			if (!w.prints.includes(print)) w.prints.push(print);
			w.labelled ??= image.type;
		} else byId.set(image.id, { id: image.id, prints: [print], labelled: image.type });
	}
	return { wanted: [...byId.values()], noImage };
}

const readImage = async (print: string, file: string): Promise<PrintImage> => {
	try {
		return { print, image: imageOf(JSON.parse(await readFile(file, 'utf8'))) };
	} catch {
		return { print, image: null };
	}
};

/** In chunks, so 18k files aren't all open at once. */
async function readAll(items: { print: string; file: string }[]): Promise<PrintImage[]> {
	const out: PrintImage[] = [];
	for (let i = 0; i < items.length; i += 256)
		out.push(...(await Promise.all(items.slice(i, i + 256).map((x) => readImage(x.print, x.file)))));
	return out;
}

export const readClone = async (dir: string) => readAll((await listClone(dir)).map((e) => ({ print: e.id, file: join(dir, e.path) })));

/** `<print id>.json` files in `dir`, skipping prints in `skip`. */
export const readDisk = async (dir: string, skip: ReadonlySet<string>) =>
	readAll(
		(await readdir(dir))
			.filter((f) => f.endsWith('.json') && isFactorioprintsId(f.slice(0, -5)) && !skip.has(f.slice(0, -5)))
			.sort()
			.map((f) => ({ print: f.slice(0, -5), file: join(dir, f) }))
	);
