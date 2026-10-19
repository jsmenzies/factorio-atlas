/**
 * Pure parts of `bun run backfill` (scripts/backfill.ts): picking a test sample, the rolling rate
 * and ETA, and the status lines shared by the live terminal view and `bun run backfill:status`.
 */
import { D1_MONTHLY_ROWS, fullRunEstimate, R2_FREE_CLASS_A, writers } from '#lib/run-estimate.js';
import type { PipelineRun } from './runs';

/**
 * `--limit n`: n records spread evenly over the source sorted by size (ties by id), so a small test
 * run always includes the smallest and the largest record and a fair spread between. Deterministic
 * for a given source listing. Returned in source order.
 */
export const sampleBySize = <T extends { readonly id: string; readonly size: number }>(entries: readonly T[], n: number): T[] => {
	if (n >= entries.length) return [...entries];
	if (n <= 0) return [];
	const bySize = [...entries].sort((a, b) => a.size - b.size || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const last = bySize.length - 1;
	const picked = new Set<string>();
	for (let i = 0; i < n; i++) picked.add(bySize[n === 1 ? Math.floor(last / 2) : Math.round((i * last) / (n - 1))].id);
	return entries.filter((e) => picked.has(e.id));
};

/**
 * Prints per second over the last `windowMs` (5 minutes), or over the whole run until that much
 * has passed. Feed it `(time, done)` samples every second or so; `reset` after a pause, so time
 * spent paused doesn't drag the rate down.
 */
export class RateWindow {
	private samples: [t: number, done: number][] = [];
	constructor(private readonly windowMs = 5 * 60_000) {}

	reset(t: number, done: number) {
		this.samples = [[t, done]];
	}

	add(t: number, done: number) {
		this.samples.push([t, done]);
		// Keep one sample at or before the window's start as the anchor.
		while (this.samples.length > 2 && this.samples[1][0] <= t - this.windowMs) this.samples.shift();
	}

	/** null until there's at least a second of samples. */
	rate(): number | null {
		if (this.samples.length < 2) return null;
		const [t0, d0] = this.samples[0];
		const [t1, d1] = this.samples[this.samples.length - 1];
		return t1 - t0 < 1000 ? null : ((d1 - d0) * 1000) / (t1 - t0);
	}
}

/** Seconds left at `rate` prints/s, or null when there's no rate yet. */
export const etaSeconds = (left: number, rate: number | null) => (left <= 0 ? 0 : rate && rate > 0 ? Math.round(left / rate) : null);

// ---------------------------------------------------------------------------------------------
// Formatting

export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');

/** 417k, 1.2M. */
export const fmtCompact = (n: number) =>
	n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : fmtInt(n);

export const fmtBytes = (n: number) =>
	n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} KB` : `${n} B`;

/** 45s, 3m 05s, 2h 04m. */
export const fmtDuration = (seconds: number) => {
	const s = Math.max(0, Math.round(seconds));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
	return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};

/** Per second when at least 1/s, else per minute. */
export const fmtRate = (perSecond: number | null) =>
	perSecond === null ? '–' : perSecond >= 1 ? `${perSecond.toFixed(perSecond >= 10 ? 0 : 1)}/s` : `${(perSecond * 60).toFixed(1)}/min`;

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

const bar = (fraction: number, width: number) => {
	const full = Math.round(Math.min(1, Math.max(0, fraction)) * width);
	return `${'█'.repeat(full)}${'░'.repeat(width - full)}`;
};

/** Live extras the terminal shows that aren't in the `pipeline_runs` row. */
export interface LiveExtras {
	slowest?: { id: string; ms: number; bytes: number } | null;
	/** Rows written by `rebuildFacets` and the run's own heartbeats (not in `rows_written`). */
	overheadRows?: number;
	/** e.g. "raw 48 · raw+token 0 · jsDelivr 0 · retries 0". */
	fetch?: string;
	inFlight?: number;
	/** Shown in place of the state, e.g. "stopping: 3 in flight". */
	note?: string;
}

/**
 * The status block: a handful of lines, the same for the live view and `backfill:status`.
 * Projections are `fullRunEstimate`: a fresh load of the whole source (`options.corpus`).
 */
export const statusLines = (run: PipelineRun, now: number, extras: LiveExtras = {}): string[] => {
	const left = Math.max(0, run.total - run.done);
	const elapsed = ((run.finished_at ?? now) - run.started_at) / 1000;
	const live = ['starting', 'running', 'paused', 'stopping'].includes(run.state);
	const lines: string[] = [];
	lines.push(`backfill → ${run.stage} · ${run.source} · run ${run.id} · ${extras.note ?? run.state}${run.error ? ` (${run.error})` : ''}`);
	const pct = run.total ? Math.floor((run.done / run.total) * 100) : 100;
	lines.push(
		`[${bar(run.total ? run.done / run.total : 1, 30)}] ${String(pct).padStart(3)}%  ${fmtInt(run.done)}/${fmtInt(run.total)} · ${fmtInt(left)} left`
	);
	const skipped = run.unchanged + run.skipped_failed;
	const reindexed = run.reindexed ?? 0;
	const updated = run.viewer + reindexed + run.favorites;
	lines.push(
		`✓ ${fmtInt(run.analysed)} analysed  ✗ ${fmtInt(run.failed)} failed  ↷ ${fmtInt(skipped)} skipped` +
			(updated ? `  ↻ ${fmtInt(updated)} updated (viewer ${run.viewer}, index ${reindexed}, favourites ${run.favorites})` : '') +
			(skipped ? `  (unchanged ${fmtInt(run.unchanged)}, known failures ${fmtInt(run.skipped_failed)})` : '')
	);
	const eta =
		live && run.eta_seconds !== null && run.state !== 'paused'
			? `ETA ${fmtDuration(run.eta_seconds)} (${clock(now + run.eta_seconds * 1000)})`
			: live
				? 'ETA –'
				: `took ${fmtDuration(elapsed)}`;
	const overall = elapsed > 0 ? run.done / elapsed : null;
	lines.push(
		`rate ${fmtRate(live ? run.rate : overall)} · ${eta} · elapsed ${fmtDuration(elapsed)}` +
			(extras.inFlight ? ` · ${extras.inFlight} in flight` : '')
	);
	const n = writers(run);
	const full = fullRunEstimate(run);
	lines.push(
		`D1 ${fmtInt(run.rows_written)} rows written · ${(n ? run.rows_written / n : 0).toFixed(1)}/print` +
			(full
				? ` · full run of ${fmtInt(full.prints)} ≈ ${fmtCompact(full.rows)} (${((full.rows / D1_MONTHLY_ROWS) * 100).toFixed(1)}% of 50M/month)`
				: '') +
			(extras.overheadRows ? ` · +${fmtInt(extras.overheadRows)} facets/status` : '')
	);
	lines.push(
		`R2 ${fmtInt(run.r2_objects)} objects · ${fmtBytes(run.r2_bytes)} · ${(n ? run.r2_objects / n : 0).toFixed(1)}/print` +
			(full
				? ` · full run ≈ ${fmtCompact(full.objects)} puts (${((full.objects * 100) / R2_FREE_CLASS_A).toFixed(0)}% of 1M free Class A), ${fmtBytes(full.bytes)}` +
					(full.byBytes ? ' (scaled by mirror bytes)' : '')
				: '')
	);
	const failures = Object.entries(run.failures)
		.sort((a, b) => b[1] - a[1])
		.map(([reason, count]) => `${reason} ${fmtInt(count)}`);
	const tail = [
		failures.length ? `failures: ${failures.join(' · ')}` : 'failures: none',
		extras.slowest ? `slowest ${extras.slowest.id} ${fmtInt(extras.slowest.ms)} ms (${fmtBytes(extras.slowest.bytes)})` : null,
		extras.fetch ? `fetch: ${extras.fetch}` : null
	].filter((s) => s !== null);
	lines.push(tail.join(' · '));
	return lines;
};

/** One line for logs and non-TTY output, every ~10 s. */
export const statusLine = (run: PipelineRun, now: number) => {
	const pct = run.total ? Math.floor((run.done / run.total) * 100) : 100;
	const failures = Object.entries(run.failures).map(([k, v]) => `${k} ${v}`);
	return (
		`[${run.stage} ${run.state}] ${fmtInt(run.done)}/${fmtInt(run.total)} ${pct}% · ✓${run.analysed} ✗${run.failed} ↷${run.unchanged + run.skipped_failed}` +
		(run.viewer + (run.reindexed ?? 0) + run.favorites ? ` ↻${run.viewer + (run.reindexed ?? 0) + run.favorites}` : '') +
		` · ${fmtRate(run.rate)}` +
		(run.eta_seconds !== null ? ` · ETA ${fmtDuration(run.eta_seconds)} (${clock(now + run.eta_seconds * 1000)})` : '') +
		` · D1 ${fmtInt(run.rows_written)} rows · R2 ${fmtInt(run.r2_objects)} obj ${fmtBytes(run.r2_bytes)}` +
		(failures.length ? ` · failures ${failures.join(', ')}` : '')
	);
};
