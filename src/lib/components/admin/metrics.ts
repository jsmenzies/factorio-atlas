/**
 * Pure helpers for /admin/pipeline: what a `pipeline_runs` row means to a person (progress,
 * outcomes, rate, ETA, D1/R2 projections). Client-safe, so the page can re-derive ages and
 * staleness every second between polls without asking the server.
 */
import type { PipelineRun, RunKind, RunState } from '#lib/server/pipeline/runs.js';

const LIVE: RunState[] = ['starting', 'running', 'paused', 'stopping'];

/** What the page calls a run's state: the stored one, or 'crashed' when a live run's heartbeat stopped. */
export type ShownState = RunState | 'crashed';

export const shownState = (run: Pick<PipelineRun, 'state' | 'updated_at'>, now: number, staleMs: number): ShownState =>
	LIVE.includes(run.state) && now - run.updated_at > staleMs ? 'crashed' : run.state;

export const isLiveState = (s: ShownState) => s === 'starting' || s === 'running' || s === 'paused' || s === 'stopping';

export const STATE_LABEL: Record<ShownState, string> = {
	starting: 'Starting',
	running: 'Running',
	paused: 'Paused',
	stopping: 'Stopping',
	finished: 'Finished',
	stopped: 'Stopped',
	failed: 'Failed',
	crashed: 'Not responding'
};

/** What stopping a backfill leaves behind (RunControls' Stop confirmation). */
export const STOP_NOTE =
	'The runner finishes the prints in flight and exits. Run the same command again to carry on; finished prints are skipped.';

export const KIND_LABEL: Record<RunKind, string> = { backfill: 'Backfill', sync: 'Daily sync', reanalyze: 'Re-analysis' };

export type OutcomeKey = 'analysed' | 'viewer' | 'reindexed' | 'favorites' | 'unchanged' | 'failed' | 'skipped_failed';

/** In bar order: work done first, then no-ops, then failures. */
export const OUTCOMES: { key: OutcomeKey; label: string; hint: string; color: string }[] = [
	{ key: 'analysed', label: 'Analysed', hint: 'new or changed: decoded, analysed and stored', color: 'bg-emerald-500' },
	{ key: 'viewer', label: 'Viewer rebuilt', hint: 'analysis current; viewer files rebuilt only', color: 'bg-sky-500' },
	{ key: 'reindexed', label: 'Re-indexed', hint: 'analysis current; D1 search rows rewritten only', color: 'bg-teal-400' },
	{ key: 'favorites', label: 'Favourites only', hint: 'only the favourite count changed', color: 'bg-violet-400' },
	{ key: 'unchanged', label: 'Unchanged', hint: 'already up to date; nothing written', color: 'bg-stone-500' },
	{ key: 'failed', label: 'Failed', hint: "couldn't be parsed or decoded in this run", color: 'bg-rose-500' },
	{
		key: 'skipped_failed',
		label: 'Skipped (known failure)',
		hint: 'failed before; skipped until its content changes',
		color: 'bg-rose-900'
	}
];

export const outcomeParts = (run: Pick<PipelineRun, OutcomeKey>) => OUTCOMES.map((o) => ({ ...o, n: run[o.key] })).filter((o) => o.n > 0);

/** "1,100 analysed · 24 failed": a run's two biggest outcomes, and failures always (from outcomeParts or renderOutcomeParts). */
export const outcomeSummary = (parts: { key: string; label: string; n: number }[]) => {
	const failed = parts.filter((p) => p.key === 'failed');
	const top = parts
		.filter((p) => p.key !== 'failed')
		.sort((a, b) => b.n - a.n)
		.slice(0, 2);
	return [...top, ...failed].map((p) => `${compact(p.n)} ${p.label.toLowerCase()}`).join(' · ') || 'nothing done';
};

const nf = new Intl.NumberFormat('en-GB');
export const int = (n: number) => nf.format(Math.round(n));

/** 1234 → "1.2k", 4_200_000 → "4.2M". */
export const compact = (n: number) =>
	n < 1000 ? int(n) : n < 1e6 ? `${+(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k` : `${+(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;

export const percent = (part: number, whole: number) => {
	if (whole <= 0) return '0%';
	const p = (part / whole) * 100;
	return p === 0 ? '0%' : p < 0.1 ? '<0.1%' : p < 10 ? `${+p.toFixed(1)}%` : `${Math.floor(p)}%`;
};

export const bytes = (n: number) => {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let v = n;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${i === 0 ? v : +v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
};

/** `unit` per second when at least one a second, else per minute (per hour when very slow); null without a rate. */
export const unitRate = (perSecond: number | null, unit: string) => {
	if (perSecond === null || !Number.isFinite(perSecond) || perSecond <= 0) return null;
	if (perSecond >= 1) return `${+perSecond.toFixed(perSecond < 10 ? 1 : 0)} ${unit}/s`;
	const perMinute = perSecond * 60;
	if (perMinute >= 1) return `${+perMinute.toFixed(perMinute < 10 ? 1 : 0)} ${unit}/min`;
	return `${+(perMinute * 60).toFixed(1)} ${unit}/h`;
};

/** "12 prints/s", "3.5 prints/min". */
export const rateText = (perSecond: number | null) => unitRate(perSecond, 'prints');

/** 45 → "45 s", 4000 → "1 h 6 min", 200000 → "2 d 7 h". */
export const duration = (ms: number) => {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s} s`;
	const m = Math.floor(s / 60);
	if (m < 60) return s % 60 && m < 10 ? `${m} min ${s % 60} s` : `${m} min`;
	const h = Math.floor(m / 60);
	if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
	const d = Math.floor(h / 24);
	return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
};

/** "5 s ago", "3 min ago". */
export const ago = (ms: number) => (ms < 2000 ? 'just now' : `${duration(ms)} ago`);

/** Calendar day of `at` in the time zone, for "today"/"tomorrow". */
const dayKey = (at: number, timeZone?: string) => new Date(at).toLocaleDateString('en-CA', { timeZone });

/**
 * "14:32", "tomorrow 02:10", "Tue 21 Oct 09:00", in `timeZone` (the viewer's, from a cookie, so the
 * server renders the same text as the browser; undefined = the runtime's own zone).
 */
export const clock = (at: number, now: number, timeZone?: string) => {
	const time = new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone });
	const day = dayKey(at, timeZone);
	if (day === dayKey(now, timeZone)) return time;
	if (day === dayKey(now + 86_400_000, timeZone)) return `tomorrow ${time}`;
	if (day === dayKey(now - 86_400_000, timeZone)) return `yesterday ${time}`;
	return `${new Date(at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone })} ${time}`;
};

/** A run's start for lists: "today 14:32", "Mon 20 Oct 09:00". */
export const when = (at: number, now: number, timeZone?: string) => {
	const c = clock(at, now, timeZone);
	return /^\d/.test(c) ? `today ${c}` : c;
};

/** A valid IANA time zone name, or null (cookie values are untrusted). */
export const validTimeZone = (tz: string | undefined) => {
	if (!tz || tz.length > 64) return null;
	try {
		new Intl.DateTimeFormat('en', { timeZone: tz });
		return tz;
	} catch {
		return null;
	}
};

/** How long the run has been going (live), or went (ended or crashed: up to its last heartbeat). */
export const elapsed = (run: Pick<PipelineRun, 'started_at' | 'updated_at' | 'finished_at'>, state: ShownState, now: number) =>
	(run.finished_at ?? (isLiveState(state) ? now : run.updated_at)) - run.started_at;

/**
 * Where the run will end up if the mix so far holds: D1 rows and R2 objects/bytes per print done,
 * times the total. Null before anything is done; exact once the run has ended.
 */
export const projection = (run: Pick<PipelineRun, 'done' | 'total' | 'rows_written' | 'r2_objects' | 'r2_bytes'>) => {
	if (run.done <= 0) return null;
	const scale = Math.max(run.total, run.done) / run.done;
	return {
		rowsPerPrint: run.rows_written / run.done,
		rows: run.rows_written * scale,
		objects: run.r2_objects * scale,
		bytes: run.r2_bytes * scale
	};
};

/** ETA as a duration from now and a clock time; counted from the heartbeat the runner computed it at. */
export const eta = (run: Pick<PipelineRun, 'eta_seconds' | 'updated_at'>, now: number) => {
	if (run.eta_seconds === null || run.eta_seconds < 0) return null;
	const at = run.updated_at + run.eta_seconds * 1000;
	return { left: Math.max(0, at - now), at };
};

/** The run's options as short chips. */
export const optionChips = (options: PipelineRun['options']) => {
	const chips: string[] = [];
	if (options.concurrency) chips.push(`${options.concurrency} worker${options.concurrency === 1 ? '' : 's'}`);
	if (options.limit) chips.push(`limit ${int(options.limit)}`);
	if (options.ids?.length) chips.push(`${options.ids.length} chosen id${options.ids.length === 1 ? '' : 's'}`);
	if (options.force) chips.push('force');
	if (options.retryFailed) chips.push('retry failed');
	return chips;
};

/** Failures by reason, biggest first. */
export const failureRows = (failures: Record<string, number>) =>
	Object.entries(failures)
		.filter(([, n]) => n > 0)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

/** One sentence: "1,204 of 1,500 done: 1,100 analysed, 80 unchanged and 24 failed." */
export const summary = (run: Pick<PipelineRun, OutcomeKey | 'done' | 'total'>) => {
	const parts = outcomeParts(run).map((o) => `${int(o.n)} ${o.label.toLowerCase()}`);
	const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? 'nothing yet');
	return `${int(run.done)} of ${int(run.total)} done: ${list}.`;
};
