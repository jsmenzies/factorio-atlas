/**
 * Rows of the offline render queue in the local D1: `render_runs` and `render_jobs` (migration 0010,
 * with columns from 0011–0013). The runner (scripts/render/queue.ts) writes them; /admin/render
 * (lib/server/admin/render.ts) reads them and sets `render_runs.control`.
 */
import type { RunControl, RunState } from '#lib/server/pipeline/runs.js';

/** How often the runner rewrites its run row and reads `control`. */
export const RENDER_HEARTBEAT_MS = 2_000;
/** A run that claims to be live with a heartbeat older than this has crashed or its machine is asleep. */
export const RENDER_STALE_MS = 30_000;

export type JobStatus = 'pending' | 'rendering' | 'done' | 'failed' | 'skipped';
export const JOB_STATUSES: JobStatus[] = ['pending', 'rendering', 'done', 'failed', 'skipped'];

export interface RenderRunRow {
	id: string;
	host: string;
	source: string;
	/** JSON: the run's options as the runner records them (RenderRunOptions in lib/server/admin/render.ts). */
	options: string;
	state: RunState;
	control: RunControl | null;
	total: number;
	done: number;
	rendered: number;
	unchanged: number;
	skipped: number;
	failed: number;
	files: number;
	bytes: number;
	rate: number | null;
	eta_seconds: number | null;
	started_at: number;
	updated_at: number;
	finished_at: number | null;
	error: string | null;
	/** Uploads (migration 0011): the bucket ('local', 'prod') or null when the run uploads nothing. */
	upload_target: string | null;
	/** Pages up, objects put and their bytes, objects deleted, pages waiting, pages failing, the latest error. */
	uploaded: number;
	upload_files: number;
	upload_bytes: number;
	upload_deleted: number;
	uploads_pending: number;
	upload_failed: number;
	upload_error: string | null;
	/** Replaced files waiting out their grace period before deletion, for the target (migration 0012). */
	upload_deletes_pending: number;
	/**
	 * Prints (migration 0013; 0 on rows from before it): those the run works on (a batch's picks, the
	 * ids given, else every print with a 2.0+ page), those whose every page reached a final state,
	 * and those with a page rendered in this run.
	 */
	prints_total: number;
	prints_done: number;
	prints_rendered: number;
	/** Upload speed (0013): bytes/s and files/s over the last minute, pages/s over the last 5 minutes (as `rate`). */
	upload_rate_bytes: number | null;
	upload_rate_files: number | null;
	upload_rate_pages: number | null;
}

/**
 * What a render run does after its last page is drawn, before it ends (`options.phase`, null while drawing):
 * the thumb step's last prints, the last page uploads, due deletions of replaced files, then its `--flags`
 * step (the row stays live through it).
 */
export type RenderRunPhase = 'thumbnails' | 'uploads' | 'deletions' | 'flags';

export interface RenderJobRow {
	print_id: string;
	path: string;
	title: string | null;
	label: string | null;
	game_version: string | null;
	entities: number;
	input_key: string;
	status: JobStatus;
	reason: string | null;
	attempts: number;
	run_id: string | null;
	files: number | null;
	bytes: number | null;
	ms: number | null;
	overview: string | null;
	stamp: string | null;
	queued_at: number;
	started_at: number | null;
	finished_at: number | null;
	uploaded_at: number | null;
}
