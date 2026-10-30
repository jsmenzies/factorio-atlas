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
	/** Each polled site (POLLED_SITES): fetched in the fetch step, admitted in the ingest step, when on. */
	polled: Record<PolledSiteId, PolledSettings>;
}

/**
 * Sites the update polls for new and changed prints (scripts/sync/polled.ts): their records go into the
 * record store's inbox in the fetch step and through the gate in the ingest step.
 */
export const POLLED_SITES = [
	{ site: 'codex', name: 'factoriocodex.com' },
	{ site: 'fprints', name: 'fprints.xyz' }
] as const;
export type PolledSiteId = (typeof POLLED_SITES)[number]['site'];

export interface PolledSettings {
	/** Fetch and admit this site's prints in every update. */
	on: boolean;
	/** Record reads an update makes at most (new and changed prints, and deletions to confirm); the rest wait. */
	perUpdate: number;
}

export const DEFAULT_POLLED: PolledSettings = { on: true, perUpdate: 1000 };

export const DEFAULT_SETTINGS: SyncSettings = {
	top: 1000,
	perUpdate: 500,
	workers: null,
	screenshots: true,
	imgurRecheck: 'never',
	authors: true,
	authorLimit: 50,
	maxChange: 0.05,
	polled: Object.fromEntries(POLLED_SITES.map((p) => [p.site, DEFAULT_POLLED])) as Record<PolledSiteId, PolledSettings>
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
		maxChange: pick('maxChange', (v) => (typeof v === 'number' && v > 0 && v <= 1 ? v : undefined)),
		polled: parsePolled(o.polled, errors)
	};
	return { settings, errors };
}

/** Each polled site's settings: a valid field kept, else the default; errors named `polled.<site>.<field>`. */
const parsePolled = (input: unknown, errors: string[]): Record<PolledSiteId, PolledSettings> => {
	const all = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
	const out = {} as Record<PolledSiteId, PolledSettings>;
	for (const { site } of POLLED_SITES) {
		const o = all[site] && typeof all[site] === 'object' ? (all[site] as Record<string, unknown>) : {};
		const field = <K extends keyof PolledSettings>(key: K, v: PolledSettings[K] | undefined): PolledSettings[K] => {
			if (!(key in o)) return DEFAULT_POLLED[key];
			if (v === undefined) errors.push(`polled.${site}.${key}`);
			return v ?? DEFAULT_POLLED[key];
		};
		out[site] = {
			on: field('on', typeof o.on === 'boolean' ? o.on : undefined),
			perUpdate: field('perUpdate', whole(o.perUpdate, 1, 100_000))
		};
	}
	return out;
};

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
	/** Its figures, from the commands' structured output (rows older than these have only `summary`). */
	details?: DetailGroup[];
}

/** One figure in a step's details: a label and its value; a long value (a path) is `muted`. */
export interface DetailRow {
	label: string;
	value: number | string;
	/** warn: something to look at; bad: a failure. */
	tone?: 'warn' | 'bad';
	muted?: boolean;
}

/** A step's figures, in groups when it has parts (the machine's copies, a bucket, a source). */
export interface DetailGroup {
	title?: string;
	rows: DetailRow[];
}

/** A row for details; `always` keeps a zero (failed 0 where failures matter), else zeros are left out. */
export const detail = (
	label: string,
	value: number | string | null | undefined,
	o: { always?: boolean; tone?: DetailRow['tone']; muted?: boolean } = {}
) =>
	value === null || value === undefined || (value === 0 && !o.always)
		? []
		: [{ label, value, ...(o.tone && value !== 0 ? { tone: o.tone } : {}), ...(o.muted ? { muted: true } : {}) } satisfies DetailRow];

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
	/** How the source's records came out, for a source whose fetch handles them itself (uploads: admitted, duplicate, …, left). */
	counts?: Record<string, number>;
	/** Its fetch ingests its records itself (uploads, through the gate): nothing for the backfill, so not in `sourceDigest`. */
	ingestsItself?: boolean;
	/** The source's `meta.ingest_due` (SourcePlan.ingestDue). */
	ingestDue?: string;
	/** A polled site (SourcePlan.polled): admitted in the ingest step, not by the backfill, so not in `sourceDigest`. */
	polled?: boolean;
}

/**
 * A fingerprint of what the backfill's sources held after the fetch: the ingest step is skipped when it
 * and the versions match. Sources that ingest their own records in the fetch (`ingestsItself`) and polled
 * sites (admitted in the ingest step, not by the backfill) are left out.
 */
export const sourceDigest = (sources: readonly SourceRun[]) =>
	sources
		.filter((s) => !s.ingestsItself && !s.polled)
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
	/** What the source is, for the Overview's list ("GitHub mirror owner/repo"); absent in older plans. */
	kind?: string;
	/** Commits (or batches) the source is ahead of this machine; absent in older plans. */
	behind?: number;
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
	/**
	 * Its fetch ingests its records itself (uploads, admitted through the gate): `added` counts records waiting
	 * for that, not prints for the backfill, which neither the ingest preview nor the ingest key counts.
	 */
	ingestsItself?: boolean;
	/** The Overview's line for where the source stands, when its cursors aren't commits ("3 waiting, oldest …"). */
	position?: string;
	/** The Overview's state for it when it has something new ("3 waiting"), in place of commits behind. */
	stateText?: string;
	/**
	 * `meta.ingest_due` on the stage (uploads/gate.ts): set when a hand-over had to purge a print another
	 * source still has. Part of the ingest key, so the next update runs the backfill that admits it again.
	 */
	ingestDue?: string | null;
	/** Why the source couldn't be checked (`sync --plan` goes on with the others); the update's fetch tries it again. */
	error?: string;
	/**
	 * A polled site (scripts/sync/polled.ts): its fetch puts new and changed records in the record store's
	 * inbox, and the ingest step admits them through the gate (never the backfill). `added`/`edited` count
	 * records to read, `deleted` prints the site no longer lists.
	 */
	polled?: boolean;
	/** Turned off in the settings: not checked, nothing fetched. */
	off?: boolean;
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
	const backfilled = fetched.filter((p) => !p.ingestsItself && !p.polled);
	const sum = (f: (p: SourcePlan) => number, of = backfilled) => of.reduce((n, p) => n + f(p), 0);
	return {
		moved: fetched.length > 0,
		/** A source the backfill reads has something new: the ingest step has work. */
		backfill: backfilled.length > 0,
		added: sum((p) => p.added),
		edited: sum((p) => p.edited),
		favourites: sum((p) => p.favourites),
		deleted: sum((p) => p.deleted.length),
		modern: sum((p) => p.modern),
		/** Records waiting for a source that admits them itself (uploads). */
		waiting: sum(
			(p) => p.added,
			fetched.filter((p) => p.ingestsItself)
		),
		/** New and changed records on polled sites (codex, fprints), read in the fetch and admitted in the ingest step. */
		polled: sum(
			(p) => p.added + p.edited,
			fetched.filter((p) => p.polled)
		)
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
