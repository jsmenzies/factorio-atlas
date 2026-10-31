/**
 * One update (`bun run sync`, scripts/sync.ts; started from the admin Update tab under `vite dev`):
 * fetch each print source (today the factorioprints mirror clone), then bring every stage-side copy
 * up to date with them, step by step. What the runner, the admin Overview and Update tabs (in the browser too) and the dev
 * plugin share: the saved settings, the steps, the sources' plans, the `sync_runs` row's shape
 * (migration 0020), the `sync_meta` documents and the estimates. The database helpers are in
 * #lib/server/sync.js.
 */
import type { RenderStages } from './render-stages.js';
import type { RunState } from '#lib/server/pipeline/runs.js';

// --- settings

export interface SyncSettings {
	/** The N most-favourited prints are rendered too, older ones included (`render --top N`). */
	top: number;
	/** Prints an update renders at most (`render --next N`); null: every print with work. */
	perUpdate: number | null;
	/** Render workers; null: the runner's default (half the CPU threads). */
	workers: number | null;
	/**
	 * A render worker is killed past this much memory (`render --mem-cap-mb`; passed only when it isn't
	 * RENDER_MEM_CAP_MB, the runner's own default). From MEM_CAP_MIN_MB to the machine's RAM less the render
	 * reserve (memCapMaxMb).
	 */
	memCapMb: number;
	/**
	 * The next update's render step also retries pages that failed every attempt (`render --retry-failed`), and
	 * takes their prints first; the update clears it once its render step has drawn (a step that stopped
	 * before drawing leaves it on).
	 */
	retryFailed: boolean;
	/** Run the render step (top list, changed records, render and upload); off: the step is skipped. */
	render: boolean;
	/**
	 * Hold a source back when its new and removed prints (the mirror's moved files too) in one update are more
	 * than this share of the prints known from it, and at least HOLD_FLOOR; edits don't count (`holdBack`). A
	 * held-back update can be accepted.
	 */
	maxChange: number;
	/** Each polled site (POLLED_SITES): fetched in the fetch step, admitted in the ingest step, when `on` (default). */
	polled: Record<PolledSiteId, { on: boolean }>;
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

/**
 * The hold-back rule, the same for every source the update fetches (the mirror and the polled sites): a source
 * is held back (its fetch skipped, the others carry on; Accept lets that one change through) when its new and
 * removed prints in one update (the mirror's moved files too) are more than `maxChange` of the prints this
 * machine knows from it, and never for fewer than HOLD_FLOOR. Edits never count. A first import (nothing known
 * yet, something new) is held back once for Accept. Hard stops outside the share (an empty list while prints are
 * known, a rewritten mirror history) are the sources' own. Every update reads every new or changed record: there
 * is no read cap. (Settings saved before 2026-10-30 may carry `polled.<site>.perUpdate`: ignored.)
 */
export const HOLD_FLOOR = 25;

/** The most new + removed prints one update may bring from a source before it is held back. */
export const holdLimit = (maxChange: number, known: number) => Math.max(maxChange * known, HOLD_FLOOR);

/**
 * Why a source is held back, or null: its counts, the share and the floor ("62 new, 3 removed: more than 5% (25
 * at least) of 466; check the site, then accept it if it's right"). `what` names the source for the advice.
 */
export function holdBack(o: {
	added: number;
	removed: number;
	/** The mirror's files that moved (a layout change), counted with the rest. */
	moved?: number;
	known: number;
	maxChange: number;
	accepted?: boolean;
	what?: string;
}): string | null {
	if (o.accepted) return null;
	const n = (x: number) => x.toLocaleString('en-US');
	const counts = [`${n(o.added)} new`, `${n(o.removed)} removed`, ...(o.moved ? [`${n(o.moved)} moved`] : [])].join(', ');
	if (o.known === 0)
		return o.added + o.removed + (o.moved ?? 0) > 0
			? `${counts}: a first import; check ${o.what ?? 'the site'}, then accept it to import them`
			: null;
	if (o.added + o.removed + (o.moved ?? 0) <= holdLimit(o.maxChange, o.known)) return null;
	return (
		`${counts}: more than ${Math.round(o.maxChange * 100)}% (${HOLD_FLOOR} at least) of ${n(o.known)}; ` +
		`check ${o.what ?? 'the site'}, then accept it if it's right`
	);
}

/** The render runner's own `--mem-cap-mb` default (scripts/render/args.ts). */
export const RENDER_MEM_CAP_MB = 6144;
/** The smallest memory cap a worker may be given: the runner's recycle size (`--recycle-mb` 3072), so a warm worker is recycled, not killed mid-page. */
export const MEM_CAP_MIN_MB = 3072;
/** RAM the render runner keeps free beside its pages (`--mem-reserve-mb`'s default): the larger of 2 GB and 10%. */
export const renderReserveMb = (ramMb: number) => Math.round(Math.max(2048, ramMb * 0.1));
/** The largest memory cap a worker may be given on a machine with this much RAM: all of it less the reserve. */
export const memCapMaxMb = (ramMb: number) => Math.max(MEM_CAP_MIN_MB, Math.floor(ramMb - renderReserveMb(ramMb)));

export const DEFAULT_SETTINGS: SyncSettings = {
	top: 1000,
	perUpdate: 500,
	workers: null,
	memCapMb: RENDER_MEM_CAP_MB,
	retryFailed: false,
	render: true,
	maxChange: 0.05,
	polled: Object.fromEntries(POLLED_SITES.map((p) => [p.site, { on: true }])) as Record<PolledSiteId, { on: boolean }>
};

/** The render step's own flags from the settings: workers, the memory cap (only when not the default) and retry. */
export const renderSettingArgs = (s: Pick<SyncSettings, 'workers' | 'memCapMb' | 'retryFailed'>): string[] => [
	...(s.workers ? ['--workers', String(s.workers)] : []),
	...(s.memCapMb !== RENDER_MEM_CAP_MB ? ['--mem-cap-mb', String(s.memCapMb)] : []),
	...(s.retryFailed ? ['--retry-failed'] : [])
];

/** Saved settings with "retry failed pages" turned off, every other field as saved; null when nothing changes. */
export const withoutRetry = (saved: unknown): Record<string, unknown> | null =>
	saved && typeof saved === 'object' && !Array.isArray(saved) && (saved as Record<string, unknown>).retryFailed
		? { ...(saved as Record<string, unknown>), retryFailed: false }
		: null;

const whole = (v: unknown, min: number, max: number) =>
	typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;

/**
 * Settings from stored or posted JSON: each valid field kept, anything else the default. `errors`
 * names the fields that were given but invalid, so a form can say so. With `ramMb` (the machine's RAM),
 * `memCapMb` is held to memCapMaxMb; without, only to MEM_CAP_MIN_MB and up. Old keys (`authors`, `screenshots`:
 * those steps always run; `authorLimit`, `imgurRecheck`) are ignored.
 */
export function parseSettings(input: unknown, machine: { ramMb?: number | null } = {}): { settings: SyncSettings; errors: string[] } {
	const capMax = machine.ramMb ? memCapMaxMb(machine.ramMb) : 1 << 22;
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
		// The default is always allowed, so a small machine (RAM less the reserve under 6 GB) can still save the rest.
		memCapMb: pick('memCapMb', (v) => (v === RENDER_MEM_CAP_MB ? v : whole(v, MEM_CAP_MIN_MB, capMax))),
		retryFailed: pick('retryFailed', (v) => (typeof v === 'boolean' ? v : undefined)),
		render: pick('render', (v) => (typeof v === 'boolean' ? v : undefined)),
		maxChange: pick('maxChange', (v) => (typeof v === 'number' && v > 0 && v <= 1 ? v : undefined)),
		polled: parsePolled(o.polled, errors)
	};
	return { settings, errors };
}

/** Each polled site's `on`: kept when a boolean, else on (an invalid one named `polled.<site>.on`). Other fields (an old `perUpdate`) are ignored. */
const parsePolled = (input: unknown, errors: string[]): Record<PolledSiteId, { on: boolean }> => {
	const all = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
	const out = {} as Record<PolledSiteId, { on: boolean }>;
	for (const { site } of POLLED_SITES) {
		const o = all[site] && typeof all[site] === 'object' ? (all[site] as Record<string, unknown>) : {};
		if ('on' in o && typeof o.on !== 'boolean') errors.push(`polled.${site}.on`);
		out[site] = { on: typeof o.on === 'boolean' ? o.on : true };
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
	/** The render step: its run's stages per source as the run ended (#lib/render-stages.js). */
	render?: RenderStages;
	/** Figures the board reads as they are, not from `summary` or a row's words (rows older than these have none). */
	figures?: StepFigures;
}

/** A step's typed figures for the board (flow.ts), beside its `details` for people. */
export interface StepFigures {
	/** ingest: why the backfill was skipped, when the polled sites were admitted after it. */
	backfillSkipped?: string;
	/** screenshots: the files put in the stage's bucket (the upload screenshots' left out), and their bytes. */
	bucketPut?: { files: number; bytes: number };
}

/** Bytes as the screenshots step shows them: "156.1 MB". */
export const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

/** The screenshots step's group of one site's images (`From other sites: codex`). */
export const SITE_SHOTS_GROUP = 'From other sites: ';

/**
 * The detail rows the Update tab reads back from a step's figures (flow.ts, view.ts): the steps write them
 * (scripts/sync.ts, scripts/sync/*.ts) and the board reads them through these names only, so rewording one
 * can't silently empty a cell. Rows only shown, never read, keep their words where they are written.
 */
export const ROW = {
	// fetch
	printsOnSite: 'prints on the site',
	waiting: 'waiting',
	oldestWaiting: 'oldest waiting',
	stillProcessing: 'still processing',
	position: 'position',
	// ingest
	analysed: 'analysed',
	reindexed: 're-indexed',
	folded: 'copies folded',
	failed: 'failed',
	toAdmit: 'records to admit',
	newPrints: 'new prints',
	joined: 'joined an existing print',
	updated: 'updated',
	unchanged: 'unchanged',
	blocked: 'blocked',
	unreadable: 'unreadable',
	suggestions: 'new, with suggestions to look at',
	failedRetried: 'failed, tried again next update',
	// authors
	authorsNamed: 'authors named',
	// screenshots
	fetched: 'fetched',
	newlyDead: 'newly dead',
	alreadyCopied: 'already copied',
	deadOnImgur: 'dead on Imgur',
	toFetch: 'to fetch',
	approved: 'approved',
	copiedFromRaw: 'copied from RAW',
	sized: 'sized',
	alreadyUp: 'already up',
	imagesShown: 'images shown',
	copiedNow: 'copied now',
	goneAtSource: 'gone at the source',
	maybeDead: 'answered 404 once (asked again next update)',
	filesPut: 'files put',
	sizesMade: 'sizes made',
	deleted: 'deleted'
} as const;

/** The detail groups the Update tab finds by title. */
export const GROUP = {
	/** A polled site's admission in the ingest step. */
	gate: (site: string) => `${site}: through the gate`,
	/** Imgur's copies in the screenshots step. */
	onThisMachine: 'On this machine',
	fromUploads: 'From uploads',
	siteShots: (site: string) => `${SITE_SHOTS_GROUP}${site}`,
	/** The screenshots bucket: "Prod bucket". */
	bucket: (stage: string) => `${stage[0].toUpperCase()}${stage.slice(1)} bucket`,
	isBucket: (title: string) => title.endsWith(' bucket'),
	searchCards: 'Search cards',
	authors: 'Author names'
} as const;

/** A step's detail group whose title matches. */
export const groupOf = (step: SyncStep | undefined, match: (title: string) => boolean): DetailGroup | undefined =>
	step?.details?.find((g) => g.title !== undefined && match(g.title));
/** A group's row by label, when its value is a number. */
export const valueOf = (g: DetailGroup | undefined, label: string): number | undefined => {
	const v = g?.rows.find((r) => r.label === label)?.value;
	return typeof v === 'number' ? v : undefined;
};

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

/** One source in an update: its cursor before and after the fetch. */
export interface SourceRun {
	site: string;
	from: SourceCursor | null;
	to: SourceCursor | null;
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
	/** A polled site's reads left over from the last update (a stop or failed reads), counted in `added`/`edited`; absent in older plans. */
	left?: number;
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
	/** The fields below were added on 2026-10-30: figures counted before then lack them. */
	/** Prints by the site they are credited to (`prints.source`), and how many of them are folded copies (`duplicate_of`). */
	bySource?: Record<string, { prints: number; folded: number }>;
	/** Live sources by site (`print_sources`), joined copies of prints credited elsewhere included. */
	sourceRecords?: Record<string, number>;
	/** What needs looking at: open removal requests, upload screenshots to approve, accounts being deleted, uploads still processing. */
	attention?: { reports: number; screenshots: number; deleting: number; processing: number };
}

/**
 * The record store's prints (other sites and uploads) a render run would draw: those with a 2.0+ page, as
 * `[print id, record file stamp]` (scripts/render/store-scope.ts). The Update tab counts those the render queue
 * hasn't looked at at that stamp.
 */
export interface StorePrints {
	at: number;
	modern: [string, string][];
	/** Records with no 2.0+ page (never rendered), and records that couldn't be decoded. */
	older: number;
	unreadable: number;
}

/**
 * settings, plan, figures: above; accept: a held-back source update to fetch anyway, by site (its `to` cursor id);
 * store-prints: above. An old 'imgur-recheck' row (the Imgur recheck, removed) is never read.
 */
export type SyncMetaKey = 'settings' | 'plan' | 'figures' | 'accept' | 'store-prints';

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
