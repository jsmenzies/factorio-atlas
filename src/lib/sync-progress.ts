/**
 * Live progress of a running update (the dev plugin's `/admin/__sync/log?progress=1`): the steps only record their
 * figures when they end, but the scripts they run report each record as they go, which the Update tab counts while
 * a step runs. Only the current step's part is counted (after its last `step` event). Browser-safe; the reading is
 * pure.
 *
 * Since 2026-10-31 the update keeps these as typed events, one JSON object a line, in a file beside its log
 * (`progressFileOf`; scripts/sync/progress.ts writes them, to the file named in SYNC_PROGRESS_ENV): `step` and
 * `command` from the runner (scripts/sync/runner.ts), `record` per polled site's record in the fetch
 * (scripts/sync/polled.ts applyPoll) and through the gate (scripts/polled.ts), `admit` the admission's total
 * (scripts/polled.ts), `shots` and `shot` for other sites' images (scripts/screenshots/sites.ts). foldProgress
 * reads them; the log's wording is for people only.
 *
 * Updates from before then have no such file: logProgress reads their logs, by these lines (never change it):
 * - `codex/494: new`, `fprints/<uuid>: undecodable (…)`, `codex/323: failed (…)`, `codex/12: ✗ …`: a record;
 * - `prod ← codex inbox …: 431 records to admit, 0 gone from the site`: the admission's total;
 * - `screenshots: 749 images from other sites shown in prod: … to copy 716 → …`: other sites' images to copy, and
 *   `screenshots: codex.<hex> (<print>): fetched` or `: failed (…)` per image;
 * - `$ bun scripts/screenshots.ts --from-sites prod --json`: the command the step runs now.
 * The render step's progress isn't read here: the render run writes it to its row (`options.stages`).
 */
import { SYNC_STEPS, type SyncStepId } from './sync.js';

export interface LogProgress {
	/** The step whose part of the log was counted (its `== <label>` header), or null before the first. */
	step: SyncStepId | null;
	/** Per site, its records' outcomes in that part: `new`, `changed`, `same`, `joined`, `failed`, `undecodable`, … */
	sites: Record<string, Record<string, number>>;
	/** Per polled site, the records its admission started with. */
	toAdmit: Record<string, number>;
	/**
	 * Other sites' images: how many there were to copy, per site those copied and failed so far, and the site of
	 * the last one (the one being copied).
	 */
	shots: { toCopy: number | null; bySite: Record<string, { fetched: number; failed: number }>; last: string | null };
	/** The step's last command (`scripts/screenshots.ts --from-sites prod --json`, without `$ bun `), or null. */
	command: string | null;
}

/** The environment variable naming the progress file to a step's process (scripts/sync/progress.ts). */
export const SYNC_PROGRESS_ENV = 'ATLAS_SYNC_PROGRESS';

/** The progress file beside an update's log: `sync-<time>.log` → `sync-<time>.progress.jsonl`. */
export const progressFileOf = (log: string) => log.replace(/\.log$/, '.progress.jsonl');

/** One line of the progress file. */
export type ProgressEvent =
	/** A step started (the log's `== <label>` header): counting starts again. */
	| { t: 'step'; step: SyncStepId }
	/** The step runs this command now (without `bun `). */
	| { t: 'command'; command: string }
	/** A polled site's record: its outcome's first word (`new`, `same`, `joined`, `gone`, `failed`, …). */
	| { t: 'record'; site: string; outcome: string }
	/** A polled site's admission starts with this many records. */
	| { t: 'admit'; site: string; records: number }
	/** Other sites' images to copy. */
	| { t: 'shots'; toCopy: number }
	/** One of them copied, or failed (an image found dead has none). */
	| { t: 'shot'; site: string; outcome: 'fetched' | 'failed' };

const empty = (step: SyncStepId | null): LogProgress => ({
	step,
	sites: {},
	toAdmit: {},
	shots: { toCopy: null, bySite: {}, last: null },
	command: null
});

const countRecord = (out: LogProgress, site: string, outcome: string) => {
	const s = (out.sites[site] ??= {});
	s[outcome] = (s[outcome] ?? 0) + 1;
};
const countShot = (out: LogProgress, site: string, outcome: 'fetched' | 'failed') => {
	const s = (out.shots.bySite[site] ??= { fetched: 0, failed: 0 });
	if (outcome === 'fetched') s.fetched++;
	else s.failed++;
	out.shots.last = site;
};

/** Counts the current step's events in a progress file's text (a line that doesn't parse is skipped). */
export function foldProgress(text: string): LogProgress {
	let out = empty(null);
	for (const line of text.split('\n')) {
		let e: ProgressEvent;
		try {
			e = JSON.parse(line) as ProgressEvent;
		} catch {
			continue;
		}
		if (e?.t === 'step') out = empty(SYNC_STEPS.find((s) => s.id === e.step)?.id ?? null);
		else if (e?.t === 'command') out.command = e.command;
		else if (e?.t === 'record') countRecord(out, e.site, e.outcome);
		else if (e?.t === 'admit') out.toAdmit[e.site] = e.records;
		else if (e?.t === 'shots') out.shots.toCopy = e.toCopy;
		else if (e?.t === 'shot') countShot(out, e.site, e.outcome);
	}
	return out;
}

const HEADER = /^== (.+)$/;
const RECORD = /^([a-z]+)\/[^\s:]+: (✗|[a-z]+)/;
const TO_ADMIT = /^\S+ ← ([a-z]+) inbox .*: ([\d,]+) records to admit/;
const SHOTS_TO_COPY = /^screenshots: [\d,]+ images from other sites shown in \S+: .*to copy ([\d,]+)/;
const SHOT = /^screenshots: ([a-z]+)\.[0-9a-f]+ \([^)]*\): (fetched|failed)/;
const COMMAND = /^\$ bun (.+)$/;

const num = (s: string) => Number(s.replace(/,/g, ''));

/** Counts the current step's part of a log written before progress files (its tail is enough when it holds that step's header). */
export function logProgress(text: string): LogProgress {
	const lines = text.split('\n');
	let start = 0;
	let step: SyncStepId | null = null;
	for (let i = lines.length - 1; i >= 0; i--) {
		const m = HEADER.exec(lines[i]);
		if (!m) continue;
		start = i + 1;
		step = SYNC_STEPS.find((s) => s.label === m[1].trim())?.id ?? null;
		break;
	}
	const out = empty(step);
	for (let i = start; i < lines.length; i++) {
		const line = lines[i];
		let m = RECORD.exec(line);
		if (m) {
			countRecord(out, m[1], m[2] === '✗' ? 'failed' : m[2]);
			continue;
		}
		if ((m = COMMAND.exec(line))) out.command = m[1];
		else if ((m = TO_ADMIT.exec(line))) out.toAdmit[m[1]] = num(m[2]);
		else if ((m = SHOTS_TO_COPY.exec(line))) out.shots.toCopy = num(m[1]);
		else if ((m = SHOT.exec(line))) countShot(out, m[1], m[2] as 'fetched' | 'failed');
	}
	return out;
}

/** Every record a site has written in the counted part, whatever its outcome. */
export const recordsSeen = (p: LogProgress | null, site: string) => Object.values(p?.sites[site] ?? {}).reduce((a, b) => a + b, 0);
