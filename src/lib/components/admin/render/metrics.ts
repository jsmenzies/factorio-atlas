/**
 * Pure helpers for /admin/render: what a `render_runs` row and its `render_jobs` mean to a person
 * (outcomes, page rate, storage projection, links to a page's render). Client-safe. Shared
 * formatting (durations, bytes, clocks, the crashed-run inference) comes from ../metrics.ts.
 */
import type { RenderJob, RenderRun, RenderRunOptions } from '#lib/server/admin/render.js';
import { plainText } from '#lib/richtext.js';
import { bytes, int, unitRate } from '../metrics.js';

export type RenderOutcomeKey = 'rendered' | 'unchanged' | 'skipped' | 'failed';

/** In bar order: work done, no-ops, pages not drawn, failures. */
/** What stopping a render run leaves behind (RunControls' Stop confirmation). */
export const RENDER_STOP_NOTE =
	'The renderer finishes the pages in flight and exits. Run the same command again to carry on; rendered pages are never drawn again.';

export const RENDER_OUTCOMES: { key: RenderOutcomeKey; label: string; hint: string; color: string }[] = [
	{ key: 'rendered', label: 'Rendered', hint: 'drawn and written in this run', color: 'bg-emerald-500' },
	{ key: 'unchanged', label: 'Unchanged', hint: 'already rendered with the same input; nothing written', color: 'bg-stone-500' },
	{ key: 'skipped', label: 'Skipped', hint: 'not drawable: modded, empty or older than 2.0', color: 'bg-amber-500/80' },
	{ key: 'failed', label: 'Failed', hint: 'crashed or timed out on its last attempt', color: 'bg-rose-500' }
];

export const renderOutcomeParts = (run: Pick<RenderRun, RenderOutcomeKey>) =>
	RENDER_OUTCOMES.map((o) => ({ ...o, n: run[o.key] })).filter((o) => o.n > 0);

/** "2.5 pages/s", "40 pages/min". */
export const pageRate = (perSecond: number | null) => unitRate(perSecond, 'pages');

/**
 * Storage the rest of the run may need: bytes per page rendered so far × pages left (an upper bound,
 * since unchanged and skipped pages write nothing), and the same scaled by the share of pages that
 * rendered so far. Null until a page has rendered.
 */
export const storageProjection = (run: Pick<RenderRun, 'total' | 'done' | 'rendered' | 'files' | 'bytes'>) => {
	if (run.rendered <= 0) return null;
	const left = Math.max(0, run.total - run.done);
	const perPage = run.bytes / run.rendered;
	const share = run.done > 0 ? run.rendered / run.done : 1;
	return {
		perPage,
		filesPerPage: run.files / run.rendered,
		left,
		share,
		upTo: perPage * left,
		likely: perPage * left * share
	};
};

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);

/** The run's options as short chips; tolerant of whatever shape `assets` takes. */
export const renderOptionChips = (options: RenderRunOptions) => {
	const chips: string[] = [];
	const assets = options.assets;
	let assetText = str(assets);
	if (assets && typeof assets === 'object') {
		const a = assets as Record<string, unknown>;
		assetText = str(a.version) ?? str(a.id);
	}
	if (assetText) chips.push(`assets ${assetText}`);
	if (typeof options.quality === 'number') chips.push(`q${options.quality}`);
	if (typeof options.effort === 'number') chips.push(`effort ${options.effort}`);
	if (Array.isArray(options.levels) && options.levels.length) chips.push(`${options.levels.join('/')} px/tile`);
	if (typeof options.workers === 'number') chips.push(`${options.workers} worker${options.workers === 1 ? '' : 's'}`);
	if (typeof options.limit === 'number' && options.limit > 0) chips.push(`limit ${int(options.limit)}`);
	const batch = options.batch;
	if (typeof options.next === 'number' && options.next > 0) {
		const picked = Array.isArray(batch?.picked) ? batch.picked.length : 0;
		chips.push(`next ${int(options.next)}${batch ? ` · ${int(picked)} picked${batch.complete ? '' : ' so far'}` : ''}`);
		if (typeof batch?.left === 'number') chips.push(`≈ ${int(batch.left)} prints left after it`);
		else if (typeof batch?.candidates === 'number') chips.push(`${int(batch.candidates)} prints may have work`);
	} else if (typeof options.batchOf === 'number') chips.push(`batch of ${int(options.batchOf)}, resumed`);
	else if (Array.isArray(options.ids) && options.ids.length)
		chips.push(`${options.ids.length} chosen id${options.ids.length === 1 ? '' : 's'}`);
	else if (typeof options.idsCount === 'number' && options.idsCount > 0) chips.push(`${int(options.idsCount)} chosen ids`);
	if (typeof options.top === 'number' && options.top > 0) {
		const list = options.topList;
		chips.push(`top ${int(options.top)} favourites${list ? ` · ${int(list.added)} first${list.refreshed ? ', list refreshed' : ''}` : ''}`);
	}
	if (options.force) chips.push('force');
	if (options.forcePending) chips.push('force (pages left pending)');
	if (typeof options.upload === 'string') chips.push(`upload → ${options.upload}`);
	if (typeof options.resumedFrom === 'string') chips.push('resumed');
	return chips;
};

/** Upload progress of a run: pages up out of up + waiting. Null when the run uploads nothing. */
export const uploadProgress = (run: Pick<RenderRun, 'upload_target' | 'uploaded' | 'uploads_pending'>) => {
	if (!run.upload_target) return null;
	const whole = run.uploaded + run.uploads_pending;
	return { whole, pct: whole > 0 ? Math.min(100, (run.uploaded / whole) * 100) : null };
};

/**
 * Prints finished (every page in a final state: rendered, unchanged, skipped or failed) of the
 * prints the run works on: a batch's picks, the ids given, else every print with a 2.0+ page.
 * `picking`: a batch still choosing its prints, so `total` is what it picked so far and `goal` its N.
 * Null for rows written before migration 0013, or before the run knows any print.
 */
export const printProgress = (run: Pick<RenderRun, 'options'> & Partial<Pick<RenderRun, 'prints_total' | 'prints_done'>>) => {
	const total = run.prints_total ?? 0;
	const done = Math.min(total, run.prints_done ?? 0);
	const batch = run.options.batch;
	const picking = !!batch && !batch.complete;
	if (total <= 0 && !picking) return null;
	return { done, total, picking, goal: picking ? (batch?.next ?? null) : null, pct: total > 0 ? (done / total) * 100 : null };
};

/** What the run wrote, on average per rendered page and per print with a page rendered in it. */
export const writtenAverages = (run: Pick<RenderRun, 'bytes' | 'files' | 'rendered'> & Partial<Pick<RenderRun, 'prints_rendered'>>) => {
	const prints = run.prints_rendered ?? 0;
	return {
		perPage: run.rendered > 0 ? run.bytes / run.rendered : null,
		filesPerPage: run.rendered > 0 ? run.files / run.rendered : null,
		perPrint: prints > 0 ? run.bytes / prints : null,
		prints
	};
};

export type UploadPace = 'idle' | 'keeping-up' | 'behind' | 'stalled' | 'draining';

/**
 * Upload speed and whether uploads keep up with rendering. Now: bytes/s and files/s over the last
 * minute, pages/s over the last 5 minutes (the same window as the render rate), as the runner
 * measured them; average: over the run so far. The backlog's ETA counts what rendering adds
 * meanwhile: while pages still render it drains at (upload rate − render rate).
 * `pace`: null once the run has ended, and on rows from before the rates (`measured` false).
 */
export const uploadSpeed = (
	run: Pick<RenderRun, 'upload_target' | 'upload_bytes' | 'upload_files' | 'uploaded' | 'uploads_pending' | 'rate' | 'total' | 'done'> &
		Partial<Pick<RenderRun, 'upload_rate_bytes' | 'upload_rate_files' | 'upload_rate_pages'>>,
	elapsedMs: number,
	live: boolean
) => {
	if (!run.upload_target) return null;
	const secs = elapsedMs / 1000;
	const pos = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);
	const up = pos(run.upload_rate_pages);
	const render = live && run.done < run.total ? (pos(run.rate) ?? 0) : 0;
	const pending = run.uploads_pending;
	let pace: UploadPace | null = null;
	let etaMs: number | null = null;
	// Rows from before migration 0013 have no rates (undefined): nothing to judge the pace by.
	const measured = run.upload_rate_pages !== undefined;
	if (live && measured) {
		if (pending <= 0) pace = 'idle';
		else if (!up) pace = 'stalled';
		else if (render > 0) pace = render > up * 1.1 ? 'behind' : 'keeping-up';
		else pace = 'draining';
		const drain = (up ?? 0) - render;
		if (pending > 0 && drain > 0) etaMs = (pending / drain) * 1000;
	}
	return {
		measured,
		bytesPerSec: live ? pos(run.upload_rate_bytes) : null,
		filesPerSec: live ? pos(run.upload_rate_files) : null,
		avgBytesPerSec: secs > 0 && run.upload_bytes > 0 ? run.upload_bytes / secs : null,
		avgFilesPerSec: secs > 0 && run.upload_files > 0 ? run.upload_files / secs : null,
		uploadPagesPerSec: live ? up : null,
		renderPagesPerSec: live ? render || null : null,
		pending,
		pace,
		etaMs
	};
};

/** 3_984_588 → "3.8 MB/s". */
export const byteRate = (perSecond: number | null) => (perSecond === null ? '–' : `${bytes(perSecond)}/s`);

/** 88.6 → "89 files/s", 0.42 → "0.4 files/s". */
export const fileRate = (perSecond: number | null) => (perSecond === null ? '–' : `${+perSecond.toFixed(perSecond < 10 ? 1 : 0)} files/s`);

/** Pages a minute, the unit render and upload rates are compared in: 0.2 → "12/min". */
export const perMinute = (perSecond: number | null) => {
	if (perSecond === null) return '–';
	const m = perSecond * 60;
	return `${+m.toFixed(m < 10 ? 1 : 0)}/min`;
};

type JobRef = Pick<RenderJob, 'print_id' | 'path'>;

/** `?page=` for a book path; a lone blueprint ('') needs none. */
const pageQuery = (path: string) => (path ? `?page=${path}` : '');

/** The overview image, through the site's render file route; its name carries the stamp, so it's cacheable for good. */
export const thumbUrl = (job: JobRef & Pick<RenderJob, 'overview'>) =>
	job.overview ? `/prints/${job.print_id}/render/${job.overview}` : null;

export const viewerHref = (job: JobRef) => `/prints/${job.print_id}/render${pageQuery(job.path)}`;
export const printHref = (job: JobRef) => `/prints/${job.print_id}${pageQuery(job.path)}`;

/** "Page 3/1 · Smelting" for book pages, the label alone (or "Blueprint") for a lone one. */
export const pageName = (job: Pick<RenderJob, 'path' | 'label'>) => {
	const label = job.label ? plainText(job.label) : '';
	if (!job.path) return label || 'Blueprint';
	return label ? `Page ${job.path} · ${label}` : `Page ${job.path}`;
};

/** 850 → "850 ms", 12_300 → "12.3 s". */
export const ms = (n: number | null) =>
	n === null ? '–' : n < 1000 ? `${Math.round(n)} ms` : `${+(n / 1000).toFixed(n < 10_000 ? 2 : 1)} s`;
