/**
 * One update (`bun run sync`, scripts/sync.ts; started from the admin Overview under `vite dev`):
 * fetch each print source (today the factorioprints mirror clone), then bring every stage-side copy
 * up to date with them, step by step. What the runner, the Overview (in the browser too) and the dev
 * plugin share: the saved settings, the steps, the sources' plans, the `sync_runs` row's shape
 * (migration 0020), the `sync_meta` documents and the estimates. The database helpers are in
 * #lib/server/sync.js.
 */
import type { RunState } from '#lib/server/pipeline/runs.js';

// --- settings

export interface SyncSettings {
	/** The N most-favourited prints are rendered too, older ones included (`render --top N`). */
	top: number;
	/** Prints an update renders at most (`render --next N`); null: every print with work. */
	perUpdate: number | null;
	/** Render workers; null: the runner's default (half the CPU threads). */
	workers: number | null;
	/** Copy new screenshots from Imgur, upload them and update the stage's screenshot rows. */
	screenshots: boolean;
	/** Ask Imgur whether copied screenshots were deleted, at most this often (≈ 75 min for 18k). */
	imgurRecheck: 'never' | 'weekly';
	/** Name new authors, asking Firebase about at most `authorLimit` an update. */
	authors: boolean;
	authorLimit: number;
	/**
	 * Hold a source back when the prints added, deleted or moved since the last fetch are more than this
	 * share of them (a layout change); edits in place don't count. A held-back update can be accepted.
	 */
	maxChange: number;
}

export const DEFAULT_SETTINGS: SyncSettings = {
	top: 1000,
	perUpdate: 500,
	workers: null,
	screenshots: true,
	imgurRecheck: 'never',
	authors: true,
	authorLimit: 50,
	maxChange: 0.05
};

const whole = (v: unknown, min: number, max: number) =>
	typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;

/**
 * Settings from stored or posted JSON: each valid field kept, anything else the default. `errors`
 * names the fields that were given but invalid, so a form can say so.
 */
export function parseSettings(input: unknown): { settings: SyncSettings; errors: string[] } {
	const o = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
	const errors: string[] = [];
	const pick = <K extends keyof SyncSettings>(key: K, valid: (v: unknown) => SyncSettings[K] | undefined): SyncSettings[K] => {
		if (!(key in o)) return DEFAULT_SETTINGS[key];
		const v = valid(o[key]);
		if (v === undefined) {
			errors.push(key);
			return DEFAULT_SETTINGS[key];
		}
		return v;
	};
	const settings: SyncSettings = {
		top: pick('top', (v) => whole(v, 0, 100_000)),
		perUpdate: pick('perUpdate', (v) => (v === null ? null : whole(v, 1, 100_000))),
		workers: pick('workers', (v) => (v === null ? null : whole(v, 1, 64))),
		screenshots: pick('screenshots', (v) => (typeof v === 'boolean' ? v : undefined)),
		imgurRecheck: pick('imgurRecheck', (v) => (v === 'never' || v === 'weekly' ? v : undefined)),
		authors: pick('authors', (v) => (typeof v === 'boolean' ? v : undefined)),
		authorLimit: pick('authorLimit', (v) => whole(v, 1, 1000)),
		maxChange: pick('maxChange', (v) => (typeof v === 'number' && v > 0 && v <= 1 ? v : undefined))
	};
	return { settings, errors };
}

// --- steps

export const SYNC_STEPS = [
	{ id: 'removals', label: 'Apply removals' },
	{ id: 'fetch', label: 'Fetch new prints' },
	{ id: 'ingest', label: "Update the site's prints" },
	{ id: 'authors', label: 'Name new authors' },
	{ id: 'screenshots', label: 'Copy screenshots' },
	{ id: 'render', label: 'Render and upload' },
	{ id: 'figures', label: 'Count what the site has' }
] as const;
export type SyncStepId = (typeof SYNC_STEPS)[number]['id'];

/** done: ran cleanly; warning: ran, with something to look at; skipped: nothing to do, or turned off. */
export type StepStatus = 'pending' | 'running' | 'done' | 'warning' | 'failed' | 'skipped' | 'stopped';

export interface SyncStep {
	id: SyncStepId;
	status: StepStatus;
	startedAt?: number;
	finishedAt?: number;
	/** One line of what it did, or why it was skipped or failed. */
	summary?: string;
	/** The render run or backfill run it made, for a link to its page. */
	runId?: string;
	/** The exit code of its last command, when it ran one. */
	code?: number | null;
}

export const freshSteps = (): SyncStep[] => SYNC_STEPS.map(({ id }) => ({ id, status: 'pending' }));

export const stepLabel = (id: SyncStepId) => SYNC_STEPS.find((s) => s.id === id)?.label ?? id;

// --- runs

/** 'stop': end the current step cleanly, start no more; 'quit': as a second Ctrl-C, end the step at once. */
export type SyncControl = 'stop' | 'quit';

export interface SyncOptions {
	settings: SyncSettings;
	pid: number;
	/** The log file's name, in the run logs folder (<renders dir>/logs). */
	log: string;
	/** The current step's process, while one runs. */
	childPid?: number;
	/** What the ingest step's result depended on (sources' digest and pipeline versions), once it ran to the end. */
	ingestKey?: string;
}

// --- sources

/** Where a source stood: for the factorioprints mirror, a commit and its date. */
export interface SourceCursor {
	id: string;
	date: number;
}

/** One source in an update: its cursor before and after the fetch, and the ids it no longer has. */
export interface SourceRun {
	site: string;
	from: SourceCursor | null;
	to: SourceCursor | null;
	/** Prints the source deleted in this fetch (kept on the site; for the removal of gone sources later). */
	deleted?: string[];
	/** Why the fetch held it back, if it did. */
	blocked?: string;
}

/** A fingerprint of what the sources held after the fetch: the ingest step is skipped when it and the versions match. */
export const sourceDigest = (sources: readonly SourceRun[]) =>
	sources
		.map((s) => `${s.site}@${s.to?.id ?? '?'}`)
		.sort()
		.join(' ');

export interface SyncRunRow {
	id: string;
	state: RunState;
	control: SyncControl | null;
	stage: string;
	options: string;
	sources: string;
	steps: string;
	started_at: number;
	updated_at: number;
	finished_at: number | null;
	error: string | null;
}

export interface SyncRun extends Omit<SyncRunRow, 'options' | 'sources' | 'steps'> {
	options: SyncOptions;
	sources: SourceRun[];
	steps: SyncStep[];
}

export const parseSyncRun = (row: SyncRunRow): SyncRun => ({
	...row,
	options: JSON.parse(row.options) as SyncOptions,
	sources: JSON.parse(row.sources) as SourceRun[],
	steps: JSON.parse(row.steps) as SyncStep[]
});

/** How often the runner writes its row and reads `control`. */
export const SYNC_HEARTBEAT_MS = 5_000;
/** A live row without a heartbeat for this long has crashed (the runner stays up while its steps run). */
export const SYNC_STALE_MS = 60_000;

// --- sync_meta documents

/** What a fetch would bring from one source (for the mirror: its latest commit against the clone's). */
export interface SourcePlan {
	site: string;
	/** What this machine has, and what the source has now. */
	from: SourceCursor;
	to: SourceCursor;
	/** Prints in the source now. */
	prints: number;
	added: number;
	edited: number;
	/** Records whose only change is their favourite counts. */
	favourites: number;
	/** Ids the source no longer has. */
	deleted: string[];
	/** Of the added and edited prints, those with a page saved in 2.0 or later (rendered whatever the top list says). */
	modern: number;
	/** Why the fetch would hold this source back (too many changes at once, a rewritten history), if it would. */
	blocked: string | null;
}

/** What an update would do now, from the last check of every source (`bun run sync --plan`). */
export interface SyncPlan {
	checkedAt: number;
	sources: SourcePlan[];
}

/** Whether a source has something new. */
export const sourceMoved = (p: SourcePlan) => p.from.id !== p.to.id;

/** The plan's counts over the sources that would be fetched (moved and not held back). */
export const planTotals = (plan: SyncPlan | null) => {
	const fetched = (plan?.sources ?? []).filter((p) => sourceMoved(p) && !p.blocked);
	const sum = (f: (p: SourcePlan) => number) => fetched.reduce((n, p) => n + f(p), 0);
	return {
		moved: fetched.length > 0,
		added: sum((p) => p.added),
		edited: sum((p) => p.edited),
		favourites: sum((p) => p.favourites),
		deleted: sum((p) => p.deleted.length),
		modern: sum((p) => p.modern)
	};
};

/** The stage's counts, read at the end of each update (`bun run sync --figures`). */
export interface SyncFigures {
	at: number;
	stage: string;
	prints: number;
	/** ingest_state: analysed (by analyzer version) and failed. */
	analysed: Record<string, number>;
	failed: number;
	/** Prints with no author name. */
	unnamed: number;
	/** Prints flagged as rendered (print_renders). */
	rendered: number;
	/** Screenshot rows by state (copied, dead, removed). */
	screenshots: Record<string, number>;
}

/**
 * settings, plan, figures: above; imgur-recheck: when screenshots were last rechecked on Imgur (ms);
 * accept: a held-back source update to fetch anyway, by site (its `to` cursor id).
 */
export type SyncMetaKey = 'settings' | 'plan' | 'figures' | 'imgur-recheck' | 'accept';

// --- estimates

/**
 * Averages measured over the 60,653 pages rendered by 2026-10-29: pages per rendered print, uploads
 * (R2 Class A operations: tiles, overview, data, thumbnails) and bytes per page, and render time per
 * print at 8 workers (≈ 2.6 h per 1,000 prints).
 */
export const RENDER_AVERAGES = { pagesPerPrint: 11, putsPerPage: 55, bytesPerPage: 2.75e6, secondsPerPrint: 9.4 };
/** R2 Class A operations, US$ per million (beyond the free million a month). */
export const R2_CLASS_A_PER_MILLION = 4.5;
/** R2 storage, US$ per GB-month (beyond the free 10 GB). */
export const R2_STORAGE_PER_GB_MONTH = 0.015;

export const estimateRender = (prints: number) => {
	const pages = prints * RENDER_AVERAGES.pagesPerPrint;
	const puts = pages * RENDER_AVERAGES.putsPerPage;
	return {
		pages,
		puts,
		dollars: (puts / 1e6) * R2_CLASS_A_PER_MILLION,
		bytes: pages * RENDER_AVERAGES.bytesPerPage,
		storagePerMonth: ((pages * RENDER_AVERAGES.bytesPerPage) / 1e9) * R2_STORAGE_PER_GB_MONTH,
		seconds: prints * RENDER_AVERAGES.secondsPerPrint
	};
};
