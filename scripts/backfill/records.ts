/**
 * Where the backfill reads records from, at one commit of the mirror: GitHub (mirror.ts, the
 * default) or a local clone of it (`--from-clone <dir>`, src/lib/server/pipeline/mirror-clone.ts).
 */
import { cloneCommit, listClone, readCloneRecord } from '#lib/server/pipeline/mirror-clone.js';
import { listMirror, MirrorFetcher, rawUrl, resolveCommit } from './mirror';

export interface SourceEntry {
	readonly id: string;
	readonly path: string;
	readonly size: number;
}

export interface RecordSource<E extends SourceEntry = SourceEntry> {
	/** For `pipeline_runs.source`: `mirror@<sha7>` or `clone@<sha7>`. */
	readonly label: string;
	/** The mirror commit, full sha. */
	readonly sha: string;
	readonly entries: readonly E[];
	/** One record's JSON text. */
	read(entry: E, signal?: AbortSignal): Promise<string>;
	/** Where a record lives upstream, stored as the print's source URL: the GitHub raw URL at `sha` either way. */
	url(entry: E): string;
	/** One line of read stats for the status display. */
	describe(): string;
}

/** The GitHub mirror at its current commit. */
export const githubSource = async () => {
	const sha = await resolveCommit();
	const entries = await listMirror(sha);
	const fetcher = new MirrorFetcher(sha);
	return {
		label: `mirror@${sha.slice(0, 7)}`,
		sha,
		entries,
		read: async (entry, signal) => (await fetcher.fetch(entry, signal)).text,
		url: (entry) => rawUrl(sha, entry.path),
		describe: () => fetcher.describe()
	} satisfies RecordSource<(typeof entries)[number]>;
};

/** A local clone of the mirror at its checked-out commit. */
export const cloneSource = async (dir: string) => {
	const { sha, dirty } = cloneCommit(dir);
	const entries = await listClone(dir);
	const stats = { reads: 0, bytes: 0 };
	return {
		// A clone with local edits isn't the commit it names; say so.
		label: `clone@${sha.slice(0, 7)}${dirty ? '+dirty' : ''}`,
		sha,
		entries,
		read: async (entry) => {
			const text = await readCloneRecord(dir, entry);
			stats.reads++;
			stats.bytes += entry.size;
			return text;
		},
		url: (entry) => rawUrl(sha, entry.path),
		describe: () => `disk ${stats.reads} · ${(stats.bytes / 1e6).toFixed(1)} MB`
	} satisfies RecordSource<(typeof entries)[number]>;
};
