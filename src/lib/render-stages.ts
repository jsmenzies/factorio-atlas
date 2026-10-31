/**
 * A render run's stages per source, as the runner records them in `render_runs.options.stages` on every
 * heartbeat (scripts/render/stages.ts): Plan, Draw, Upload and Thumbnails for each site whose prints the run
 * looked at, then the run's Clean up and Search flags, done once. The Update tab's board shows them
 * (src/lib/components/admin/sync/flow.ts), and the update's render step keeps the last snapshot
 * (`SyncStep.render`). Every per-site figure is counted where the run counts its own totals, so the sites
 * add up to the run row (`stageMismatch`). Browser-safe and pure.
 */
import { siteOfPrintId, type Site } from './print-id.js';

/** The site a print id belongs to, or 'other' for an id no site claims. */
export type StageSite = Site | 'other';
export const stageSite = (printId: string): StageSite => siteOfPrintId(printId) ?? 'other';

/** Queueing: the site's prints in the run and its pages looked at, by what became of each. */
export interface PlanStage {
	/** Prints the run works on (a batch's picks, the ids given, else every print taken). */
	prints: number;
	/** Pages looked at: queued + unchanged + skipped + failed. */
	pages: number;
	/** Pages queued to draw. */
	queued: number;
	/** Pages already drawn with the same input key. */
	unchanged: number;
	/** Pre-2.0, empty, modded, undecodable, planners only. */
	skipped: number;
	/** Pages that had failed every attempt at this input (left as they are), or whose record is missing. */
	failed: number;
}

export interface DrawStage {
	drawn: number;
	/** Pages that failed every attempt in this run (or whose record changed under it). */
	failed: number;
	/** Queued pages not drawn or failed yet: to draw, or left pending by a stop. */
	left: number;
	/** Prints with every queued page final, and prints with a page drawn in this run. */
	printsDone: number;
	printsDrawn: number;
}

export interface UploadStage {
	/** Pages up so far in this run (catch-up pages from earlier runs too), and the objects and bytes put. */
	pages: number;
	files: number;
	bytes: number;
	/** Drawn pages waiting to go up (this run's, earlier runs' catch-up and retries). */
	waiting: number;
	/** Pages whose last upload failed, not up since. */
	failing: number;
	/**
	 * Prints all up: every queued page final (as `draw.printsDone`) and none of their pages waiting or failing.
	 * Missing in snapshots from before it was counted.
	 */
	printsUp?: number;
}

export interface ThumbsStage {
	/** Prints whose thumbnails are done, of those offered to the thumb step. */
	done: number;
	of: number;
	/**
	 * Thumbnail pages made, of those to make (known once a print is looked at), and prints whose thumbnails are
	 * made but wait for their render files to finish uploading. Missing in snapshots from before them.
	 */
	pagesMade?: number;
	pagesOf?: number;
	waitingUpload?: number;
}

export interface SiteStages {
	plan: PlanStage;
	draw: DrawStage;
	/** Null when the run doesn't upload. */
	upload: UploadStage | null;
	/** Null with --no-thumbs (or --plan-only). */
	thumbs: ThumbsStage | null;
}

/** Due deletions of replaced files, once per run (also as it starts). */
export interface CleanupStage {
	state: 'waiting' | 'running' | 'done' | 'skipped';
	/** Objects deleted after their grace period, those kept (used again), and failed deletes, in this run. */
	deleted: number;
	kept: number;
	failed: number;
	/** Deletions still waiting out their grace period, and when the next one is due (unix ms). */
	pending: number;
	nextDue: number | null;
	/** Replaced thumbnails deleted. */
	thumbsDeleted: number;
}

/** `--flags`: the upload target's search flags and cover thumbnails, and the page-cache bump, once per run, last. */
export interface FlagsStage {
	state: 'waiting' | 'running' | 'done' | 'failed';
	stage: string;
	rowsWritten?: number;
	bumped?: boolean;
	error?: string;
}

export interface RenderStages {
	v: 1;
	/** When the snapshot was taken (unix ms). */
	at: number;
	sites: Partial<Record<StageSite, SiteStages>>;
	/** Null when the run doesn't upload. */
	cleanup: CleanupStage | null;
	/** Null without `--flags`. */
	flags: FlagsStage | null;
}

/** Every site's figures added up: what the run row should say. */
export interface StageTotals {
	prints: number;
	pages: number;
	queued: number;
	unchanged: number;
	skipped: number;
	failed: number;
	drawn: number;
	printsDone: number;
	printsDrawn: number;
	uploaded: number;
	files: number;
	bytes: number;
	waiting: number;
	failing: number;
	thumbsDone: number;
	thumbsOf: number;
}

export function stageTotals(s: RenderStages): StageTotals {
	const t: StageTotals = {
		prints: 0,
		pages: 0,
		queued: 0,
		unchanged: 0,
		skipped: 0,
		failed: 0,
		drawn: 0,
		printsDone: 0,
		printsDrawn: 0,
		uploaded: 0,
		files: 0,
		bytes: 0,
		waiting: 0,
		failing: 0,
		thumbsDone: 0,
		thumbsOf: 0
	};
	for (const x of Object.values(s.sites)) {
		if (!x) continue;
		t.prints += x.plan.prints;
		t.pages += x.plan.pages;
		t.queued += x.plan.queued;
		t.unchanged += x.plan.unchanged;
		t.skipped += x.plan.skipped;
		t.failed += x.plan.failed + x.draw.failed;
		t.drawn += x.draw.drawn;
		t.printsDone += x.draw.printsDone;
		t.printsDrawn += x.draw.printsDrawn;
		t.uploaded += x.upload?.pages ?? 0;
		t.files += x.upload?.files ?? 0;
		t.bytes += x.upload?.bytes ?? 0;
		t.waiting += x.upload?.waiting ?? 0;
		t.failing += x.upload?.failing ?? 0;
		t.thumbsDone += x.thumbs?.done ?? 0;
		t.thumbsOf += x.thumbs?.of ?? 0;
	}
	return t;
}

/** The run row's counts the sites must add up to. */
export interface RunCounts {
	total: number;
	unchanged: number;
	skipped: number;
	failed: number;
	rendered: number;
	prints_total: number;
	prints_done: number;
	prints_rendered: number;
	uploaded: number;
	upload_files: number;
	upload_bytes: number;
	uploads_pending: number;
	upload_failed: number;
}

/** Where the sites' sums differ from the run row ("drawn 12 ≠ rendered 13"); empty when they agree. */
export function stageMismatch(s: RenderStages, run: RunCounts): string[] {
	const t = stageTotals(s);
	const pairs: [string, number, string, number][] = [
		['pages', t.pages, 'total', run.total],
		['unchanged', t.unchanged, 'unchanged', run.unchanged],
		['skipped', t.skipped, 'skipped', run.skipped],
		['failed', t.failed, 'failed', run.failed],
		['drawn', t.drawn, 'rendered', run.rendered],
		['prints', t.prints, 'prints_total', run.prints_total],
		['prints done', t.printsDone, 'prints_done', run.prints_done],
		['prints drawn', t.printsDrawn, 'prints_rendered', run.prints_rendered]
	];
	if (s.cleanup)
		pairs.push(
			['uploaded', t.uploaded, 'uploaded', run.uploaded],
			['files', t.files, 'upload_files', run.upload_files],
			['bytes', t.bytes, 'upload_bytes', run.upload_bytes],
			['waiting', t.waiting, 'uploads_pending', run.uploads_pending],
			['failing', t.failing, 'upload_failed', run.upload_failed]
		);
	return pairs.filter(([, a, , b]) => a !== b).map(([x, a, y, b]) => `${x} ${a} ≠ ${y} ${b}`);
}

/** Reads `options.stages` from a run row's options (or the JSON of it); null for rows from before stages. */
export function parseStages(v: unknown): RenderStages | null {
	let o = v;
	if (typeof o === 'string') {
		try {
			o = JSON.parse(o) as unknown;
		} catch {
			return null;
		}
	}
	if (!o || typeof o !== 'object') return null;
	const s = o as Partial<RenderStages>;
	return s.v === 1 && s.sites && typeof s.sites === 'object' ? (s as RenderStages) : null;
}
