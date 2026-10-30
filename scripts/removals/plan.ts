/**
 * The pure parts of `bun run removals`: which local rows and files a deleted print leaves on this
 * machine, how the local copy of the stage's blocks is brought in line, and whether a render run
 * is live. Tested in plan.test.ts.
 */
import { LIVE_STATES, type RunState } from '#lib/server/pipeline/runs.js';
import { RENDER_STALE_MS } from '#lib/server/render-queue.js';
import type { BlockRow } from '#lib/server/removal-blocks.js';
import { storeFileOf } from '../records/store.js';

/** Local D1 tables (the render queue and upload records) with rows per print. */
export const LOCAL_PRINT_TABLES = [
	'render_jobs',
	'render_prints',
	'render_uploads',
	'render_favorites',
	'render_source_changes',
	'render_deletes',
	'thumb_uploads'
] as const;

export interface Tombstone {
	print_id: string;
	kind: string;
	at: number;
}

const blockKey = (b: Pick<BlockRow, 'kind' | 'value'>) => `${b.kind}\u0000${b.value}`;

/**
 * Bring `local` in line with the stage's blocks: add what the stage has, and drop what it no longer has
 * (a removal undone there). Only for a stage other than local, whose blocks are the ones to follow.
 */
export function blockChanges(stage: readonly BlockRow[], local: readonly BlockRow[]) {
	const want = new Set(stage.map(blockKey));
	const have = new Set(local.map(blockKey));
	return { add: stage.filter((b) => !have.has(blockKey(b))), drop: local.filter((b) => !want.has(blockKey(b))) };
}

/** Images to take down locally: every `image` block, with the print it came from. */
export const imageBlocks = (blocks: readonly BlockRow[]) =>
	blocks.filter((b) => b.kind === 'image').map((b) => ({ image: b.value, print: b.print_id }));

/** A render run that claims to be live and whose heartbeat is fresh, judged as /admin/render and the update do. */
export const liveRun = (runs: readonly { id: string; state: RunState; updated_at: number }[], now: number) =>
	runs.find((r) => LIVE_STATES.includes(r.state) && now - r.updated_at <= RENDER_STALE_MS) ?? null;

/**
 * Disk paths a deleted print leaves, relative to their folders: its renders, thumbnails and record (a
 * factorioprints print's archived in data/raw, another site's in the record store, scripts/records/store.ts).
 */
export const printPaths = (id: string, dirs: { renders: string; thumbs: string; raw: string; records: string }) => [
	`${dirs.renders}/${id}`,
	`${dirs.thumbs}/${id}`,
	storeFileOf(dirs.records, id) ?? `${dirs.raw}/factorioprints/${id}.json`
];

/** A `removal_sweeps` row: a deleted print this machine swept, with its tombstone's `at` then. */
export interface Sweep {
	print_id: string;
	tomb_at: number;
}

/** Tombstones not swept yet, or deleted again since they were (a newer `at`). */
export const unswept = (tombs: readonly Tombstone[], sweeps: readonly Sweep[]) => {
	const at = new Map(sweeps.map((s) => [s.print_id, s.tomb_at]));
	return tombs.filter((t) => (at.get(t.print_id) ?? -Infinity) < t.at);
};
