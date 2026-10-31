/**
 * The factorioprints mirror clone as an update's source: fetch GitHub's latest commit without
 * touching the working tree, say what it changes (by print id, not path: the mirror once moved every
 * file, 2026-10-11), and fast-forward to it. Every git call is spawned without a shell, asynchronously
 * (the update's heartbeat and Stop keep working), never prompts, and is killed after GIT_TIMEOUT_MS
 * or when the update's signal aborts.
 */
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { holdBack, type SourceCursor, type SourcePlan } from '#lib/sync.js';
import { isModern } from '../render/scope';
import { blueprintPages, decode } from '../render/source';

export const MIRROR_SITE = 'factorioprints';
const GIT_TIMEOUT_MS = 5 * 60_000;

/** git's output, or an error with its message; `ok` lists exit codes that aren't errors. */
const run = (clone: string, args: string[], signal?: AbortSignal, ok = [0]) =>
	new Promise<{ code: number; stdout: string }>((resolve, reject) => {
		const c = spawn('git', ['-C', clone, ...args], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
			signal,
			timeout: GIT_TIMEOUT_MS
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		c.stdout.on('data', (b: Buffer) => out.push(b));
		c.stderr.on('data', (b: Buffer) => err.push(b));
		c.once('error', reject);
		c.once('close', (code, signalName) => {
			const stdout = Buffer.concat(out).toString('utf8');
			if (code !== null && ok.includes(code)) resolve({ code, stdout });
			else
				reject(
					new Error(
						`git ${args.join(' ')}: ${(Buffer.concat(err).toString('utf8') || stdout || (signalName ? `killed (${signalName})` : `exit ${code}`)).trim()}`
					)
				);
		});
	});
const git = async (clone: string, args: string[], signal?: AbortSignal) => (await run(clone, args, signal)).stdout;

const cursorOf = async (clone: string, ref: string, signal?: AbortSignal): Promise<SourceCursor> => {
	const [id, date] = (await git(clone, ['log', '-1', '--format=%H %ct', ref], signal)).trim().split(' ');
	return { id, date: Number(date) * 1000 };
};

/** A record's path → its print id (`-ky/-KY0Ipl….json` → `-KY0Ipl…`); null for other files. */
export const idOf = (path: string) => (path.endsWith('.json') ? basename(path, '.json') : null);

export interface Changes {
	added: string[];
	/** Ids whose record differs, with the paths before and after (the same unless the file moved). */
	modified: { id: string; from: string; to: string }[];
	deleted: string[];
}

/** Changes to the mirror's layout rather than its records: adds, deletions and moves (edits in place aren't). */
export const structural = (c: Changes) => c.added.length + c.deleted.length + c.modified.filter((m) => m.from !== m.to).length;

/**
 * `git diff --name-status --no-renames` lines → changes by id. A file that moved shows as deleted
 * at one path and added at another: that is one modified print.
 */
export function changesByID(nameStatus: string): Changes {
	const added = new Map<string, string>();
	const deleted = new Map<string, string>();
	const modified = new Map<string, string>();
	for (const line of nameStatus.split('\n')) {
		const [status, path] = line.split('\t');
		const id = path ? idOf(path) : null;
		if (!id) continue;
		if (status === 'A') added.set(id, path);
		else if (status === 'D') deleted.set(id, path);
		else if (status === 'M') modified.set(id, path);
	}
	const moved = [...added.keys()].filter((id) => deleted.has(id));
	return {
		added: [...added.keys()].filter((id) => !deleted.has(id)).sort(),
		modified: [
			...[...modified].map(([id, path]) => ({ id, from: path, to: path })),
			...moved.map((id) => ({ id, from: deleted.get(id)!, to: added.get(id)! }))
		].sort((a, b) => a.id.localeCompare(b.id)),
		deleted: [...deleted.keys()].filter((id) => !added.has(id)).sort()
	};
}

/** The fields a favourite changes; a record differing only in these needs no re-analysis. */
const FAVOURITE_FIELDS = ['favorites', 'numberOfFavorites'];

/** Whether two record texts differ only in their favourites. Unparsable text counts as a real edit. */
export function favouritesOnly(before: string, after: string): boolean {
	try {
		const strip = (s: string) => {
			const o = JSON.parse(s) as Record<string, unknown>;
			for (const f of FAVOURITE_FIELDS) delete o[f];
			return JSON.stringify(o);
		};
		return strip(before) === strip(after);
	} catch {
		return false;
	}
}

/** Whether a record has a blueprint page saved in 2.0 or later (the render pipeline's own test). */
const modernRecord = async (text: string) => {
	try {
		const s = (JSON.parse(text) as { blueprintString?: unknown }).blueprintString;
		if (typeof s !== 'string') return false;
		for (const page of blueprintPages(await decode(s))) if (isModern(page.version)) return true;
	} catch {
		// Undecodable: nothing to render.
	}
	return false;
};

export interface PlanOptions {
	/** Hold back when structural changes exceed this share of the prints. */
	maxChange: number;
	/** A commit accepted anyway (sync_meta 'accept'): the share isn't checked for it. */
	accept?: string;
	signal?: AbortSignal;
}

const countPrints = async (clone: string, ref: string, signal?: AbortSignal) =>
	(await git(clone, ['ls-tree', '-r', '--name-only', ref], signal)).split('\n').filter((p) => idOf(p)).length;

/**
 * Fetch the mirror's latest commit and compare it with the clone's: every mirror commit since the
 * clone was last pulled, together. Leaves the working tree alone. It holds the source back, reading
 * no records (favourites and 2.0+ counts stay 0), when the clone has commits the mirror lacks (a
 * rewritten history), when the latest commit has no prints, or by the one hold-back rule (#lib/sync.js
 * `holdBack`): adds, deletions and moves more than `maxChange` of the clone's prints and at least 25, or a first
 * import, unless that commit was accepted. Edits never count.
 */
export async function planMirror(clone: string, o: PlanOptions): Promise<SourcePlan> {
	await git(clone, ['fetch', '--quiet', 'origin'], o.signal);
	const remoteRef = '@{u}';
	const from = await cursorOf(clone, 'HEAD', o.signal);
	const to = await cursorOf(clone, remoteRef, o.signal);
	const moved = from.id !== to.id;
	const prints = await countPrints(clone, remoteRef, o.signal);
	const behind = moved ? Number((await git(clone, ['rev-list', '--count', `HEAD..${remoteRef}`], o.signal)).trim()) : 0;
	const base = {
		site: MIRROR_SITE,
		behind,
		from,
		to,
		prints,
		added: 0,
		edited: 0,
		favourites: 0,
		deleted: [] as string[],
		modern: 0
	};
	if (moved && (await run(clone, ['merge-base', '--is-ancestor', 'HEAD', remoteRef], o.signal, [0, 1])).code === 1)
		return { ...base, blocked: "the clone has commits the mirror doesn't (its history was rewritten?): clone it again before updating" };
	const before = moved ? await countPrints(clone, 'HEAD', o.signal) : prints;
	if (prints === 0)
		return { ...base, blocked: `the mirror's latest commit has no prints (${before.toLocaleString('en-US')} now): check the mirror` };
	const changes = moved
		? changesByID(await git(clone, ['diff', '--no-renames', '--name-status', 'HEAD', remoteRef], o.signal))
		: { added: [], modified: [], deleted: [] };
	const held = holdBack({
		added: changes.added.length,
		removed: changes.deleted.length,
		moved: structural(changes) - changes.added.length - changes.deleted.length,
		known: before,
		maxChange: o.maxChange,
		accepted: o.accept === to.id,
		what: 'the mirror (a layout change?)'
	});
	if (held) return { ...base, added: changes.added.length, deleted: changes.deleted, blocked: held };
	const show = (ref: string, path: string) => git(clone, ['show', `${ref}:${path}`], o.signal);
	const edited: string[] = [];
	let favourites = 0;
	for (const m of changes.modified) {
		if (favouritesOnly(await show('HEAD', m.from), await show(remoteRef, m.to))) favourites++;
		else edited.push(m.id);
	}
	const paths = new Map<string, string>();
	if (changes.added.length || edited.length) {
		const byId = new Map(changes.modified.map((m) => [m.id, m.to]));
		const addedPaths = (await git(clone, ['diff', '--no-renames', '--name-only', '--diff-filter=A', 'HEAD', remoteRef], o.signal)).split(
			'\n'
		);
		for (const p of addedPaths) {
			const id = idOf(p);
			if (id) paths.set(id, p);
		}
		for (const id of edited) paths.set(id, byId.get(id)!);
	}
	let modern = 0;
	for (const id of [...changes.added, ...edited]) {
		const path = paths.get(id);
		if (path && (await modernRecord(await show(remoteRef, path)))) modern++;
	}
	return { ...base, added: changes.added.length, edited: edited.length, favourites, deleted: changes.deleted, modern, blocked: null };
}

/** Fast-forward the clone to the commit planMirror fetched. */
export const pullMirror = async (clone: string, commit: string, signal?: AbortSignal) => {
	await git(clone, ['merge', '--ff-only', '--quiet', commit], signal);
	return cursorOf(clone, 'HEAD', signal);
};

/** A print source for the update's fetch step: say what's new (plan), then bring the local copy to it (apply). */
export interface SourceAdapter {
	site: string;
	/** Its apply ingests its records itself (uploads): none of the backfill's work (SourcePlan.ingestsItself). */
	ingestsItself?: boolean;
	/** A polled site (scripts/sync/polled.ts): its apply reads records into the inbox, the ingest step admits them. */
	polled?: boolean;
	plan(o: PlanOptions): Promise<SourcePlan>;
	/** Where the source stands after it, and how its records came out when it handles them itself (uploads). */
	apply(plan: SourcePlan, signal?: AbortSignal): Promise<SourceCursor & { counts?: Record<string, number> }>;
}

export const mirrorSource = (clone: string): SourceAdapter => ({
	site: MIRROR_SITE,
	plan: (o) => planMirror(clone, o),
	apply: (p, signal) => pullMirror(clone, p.to.id, signal)
});
