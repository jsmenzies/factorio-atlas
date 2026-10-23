/**
 * The run state: `state.jsonl` in the screenshots folder, one JSON line per image each time a run
 * settles it (fetched, dead, failed or removed), appended and never rewritten; the last line for an id wins.
 * A run that is killed loses at most the line it was writing, and the file is written before its
 * line, so a `fetched` line always names a file that was complete. Plus which images a run still has
 * to fetch, and the duplicate guard. Pure, for tests.
 */
import type { ImageKind } from './image.js';

/**
 * removed: deleted on Imgur since we copied it (`--recheck`), or taken down on request
 * (`screenshots:remove`). Never fetched or uploaded again; its line keeps the fetched fields.
 */
export type Status = 'fetched' | 'dead' | 'failed' | 'removed';

export interface StateEntry {
	/** Imgur id. */
	id: string;
	status: Status;
	/** Every print that uses the image. */
	prints: string[];
	/** The records' `image.type`, which may not be what Imgur serves. */
	labelled: string | null;
	/** For `fetched`: the stored file, relative to the screenshots folder. */
	file?: string;
	type?: ImageKind;
	bytes?: number;
	md5?: string;
	width?: number | null;
	height?: number | null;
	/** For `dead`, `failed` and `removed`. */
	reason?: string;
	/** For `removed`: who removed it. */
	by?: 'imgur' | 'request';
	attempts: number;
	/** ISO time. */
	at: string;
}

export const STATE_FILE = 'state.jsonl';

/** Imgur's ids are case-sensitive, and so is this layout: keep the folder on a case-sensitive filesystem. */
export const originalPath = (id: string, ext: string) => `originals/${id.slice(0, 2)}/${id}.${ext}`;

export const formatEntry = (e: StateEntry) => `${JSON.stringify(e)}\n`;

/** The latest entry per id; lines that don't parse (a cut-off last line) are counted and skipped. */
export function parseState(text: string): { entries: Map<string, StateEntry>; bad: number } {
	const entries = new Map<string, StateEntry>();
	let bad = 0;
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line) as StateEntry;
			if (typeof e?.id !== 'string' || !['fetched', 'dead', 'failed', 'removed'].includes(e.status)) throw new Error('not an entry');
			entries.set(e.id, e);
		} catch {
			bad++;
		}
	}
	return { entries, bad };
}

/** One image some print uses. */
export interface Wanted {
	id: string;
	prints: string[];
	labelled: string | null;
}

export interface Plan {
	todo: Wanted[];
	/** Fetched before, file present. */
	done: number;
	/** Dead before, not asked again. */
	dead: number;
	/** In the todo list because a `fetched` entry's file is gone. */
	missing: number;
	/** In the todo list because they failed before. */
	retrying: number;
	/** In the todo list because `--recheck-dead`. */
	recheck: number;
	/** Removed (deleted on Imgur, or on request): never fetched again. */
	removed: number;
}

/** What still needs fetching, in `wanted`'s order. `hasFile` says whether a fetched entry's file is still there. */
export function planWork(
	wanted: readonly Wanted[],
	state: ReadonlyMap<string, StateEntry>,
	opts: { recheckDead: boolean; hasFile: (e: StateEntry) => boolean }
): Plan {
	const plan: Plan = { todo: [], done: 0, dead: 0, missing: 0, retrying: 0, recheck: 0, removed: 0 };
	for (const w of wanted) {
		const e = state.get(w.id);
		if (!e) plan.todo.push(w);
		else if (e.status === 'fetched') {
			if (opts.hasFile(e)) plan.done++;
			else {
				plan.missing++;
				plan.todo.push(w);
			}
		} else if (e.status === 'removed') plan.removed++;
		else if (e.status === 'dead') {
			if (opts.recheckDead) {
				plan.recheck++;
				plan.todo.push(w);
			} else plan.dead++;
		} else {
			plan.retrying++;
			plan.todo.push(w);
		}
	}
	return plan;
}

/**
 * Stops a run that is being served one image for many ids, such as a regional "not available"
 * placeholder served as a normal 200. Different ids with identical bytes do happen (an author
 * uploading one screenshot for each print of a series: 4 in a row seen), so it trips only when one
 * MD5 reaches `maxIds` ids. It is a backstop: the canary, fetched again every CANARY_EVERY images,
 * is the direct check for a placeholder.
 */
export function duplicateGuard(maxIds = 25) {
	const byMd5 = new Map<string, Set<string>>();
	const add = (sum: string, id: string) => {
		let ids = byMd5.get(sum);
		if (!ids) byMd5.set(sum, (ids = new Set()));
		ids.add(id);
	};
	return {
		add,
		/** The other ids already stored with these bytes, and whether this one would make too many. */
		check(sum: string, id: string) {
			const others = [...(byMd5.get(sum) ?? [])].filter((o) => o !== id);
			return { others, tripped: others.length + 1 >= maxIds };
		},
		/** Sets of identical bytes stored under more than one id: how many sets, ids in them, the largest. */
		repeated() {
			const sizes = [...byMd5.values()].map((ids) => ids.size).filter((n) => n > 1);
			return { sets: sizes.length, ids: sizes.reduce((a, b) => a + b, 0), largest: Math.max(0, ...sizes) };
		}
	};
}
