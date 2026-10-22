/**
 * Where the runner reads prints from: a local clone of the factorioprints mirror (one JSON file
 * per print at `<lowercase first 3 chars>/<id>.json`), or a flat folder of raw records such as
 * data/raw/factorioprints. Plus the walk over a decoded print's blueprint pages.
 */
import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect } from 'effect';
import { decodeExchangeString, decodeGameVersion, OFFLINE_MAX_INFLATED_BYTES } from '#lib/server/pipeline/decode.js';
import { mirrorPath } from '#lib/server/pipeline/source.js';

type Json = Record<string, unknown>;

export interface RecordSource {
	/** e.g. `clone@96d6afa` or `disk`. */
	label: string;
	ids(): Promise<string[]>;
	read(id: string): Promise<{ title: string | null; blueprintString: string } | null>;
	/** The record file's size and mtime, without reading it: a change means the record changed. Null when missing. */
	stamp(id: string): Promise<string | null>;
	/** The record's file. */
	file(id: string): string;
}

export const fileStamp = async (file: string) => {
	try {
		const s = await stat(file);
		return `${s.size}:${Math.round(s.mtimeMs)}`;
	} catch {
		return null;
	}
};

const readRecord = async (file: string) => {
	try {
		const r = JSON.parse(await readFile(file, 'utf8')) as { title?: unknown; blueprintString?: unknown };
		if (typeof r.blueprintString !== 'string') return null;
		return { title: typeof r.title === 'string' ? r.title : null, blueprintString: r.blueprintString };
	} catch {
		return null;
	}
};

export function cloneSource(dir: string): RecordSource {
	let sha = 'unknown';
	try {
		sha = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
	} catch {
		// Not a git checkout: still readable, just unlabelled.
	}
	return {
		label: `clone@${sha}`,
		async ids() {
			const out: string[] = [];
			for (const sub of (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.'))) {
				for (const f of await readdir(join(dir, sub.name))) if (f.endsWith('.json')) out.push(f.slice(0, -5));
			}
			return out.sort();
		},
		read: (id) => readRecord(join(dir, mirrorPath(id))),
		stamp: (id) => fileStamp(join(dir, mirrorPath(id))),
		file: (id) => join(dir, mirrorPath(id))
	};
}

export function diskSource(dir: string): RecordSource {
	return {
		label: 'disk',
		ids: async () =>
			(await readdir(dir))
				.filter((f) => f.endsWith('.json'))
				.map((f) => f.slice(0, -5))
				.sort(),
		read: (id) => readRecord(join(dir, `${id}.json`)),
		stamp: (id) => fileStamp(join(dir, `${id}.json`)),
		file: (id) => join(dir, `${id}.json`)
	};
}

export const decode = (s: string) =>
	Effect.runPromise(decodeExchangeString(s, { maxInflatedBytes: OFFLINE_MAX_INFLATED_BYTES })) as Promise<unknown>;

export interface BlueprintPage {
	/** Book path, as `listPages` writes it: "" for the root, else "3", "3/1", … */
	path: string;
	label: string | null;
	/** [major, minor, patch, build] from the page or its nearest book; null when none says. */
	version: [number, number, number, number] | null;
	/** The page's blueprint body with the nearest `version` filled in (fpsr migrates by it). */
	blueprint: Json;
}

const KINDS = ['blueprint', 'blueprint_book', 'upgrade_planner', 'deconstruction_planner'] as const;
const MAX_DEPTH = 32;

/** Every blueprint page in book order, walked as #lib/viewer/extract.js does so paths match. */
export function* blueprintPages(obj: unknown, path: number[] = [], inherited: unknown = undefined): Generator<BlueprintPage> {
	if (path.length > MAX_DEPTH || !obj || typeof obj !== 'object') return;
	const kind = KINDS.find((k) => k in (obj as Json));
	if (!kind) return;
	const body = ((obj as Json)[kind] ?? {}) as Json;
	const version = body.version ?? inherited;
	if (kind === 'blueprint') {
		yield {
			path: path.join('/'),
			label: typeof body.label === 'string' ? body.label : null,
			version: decodeGameVersion(version),
			blueprint: version === undefined ? body : { ...body, version }
		};
	} else if (kind === 'blueprint_book') {
		for (const child of Array.isArray(body.blueprints) ? (body.blueprints as Json[]) : []) {
			const idx = typeof child.index === 'number' ? child.index : 0;
			yield* blueprintPages(child, [...path, idx], version);
		}
	}
}

export const versionString = (v: BlueprintPage['version']) => (v ? `${v[0]}.${v[1]}.${v[2]}` : null);
