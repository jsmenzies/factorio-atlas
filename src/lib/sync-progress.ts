/**
 * Live progress of a running update (the dev plugin's `/admin/__sync/log?progress=1`): the steps only record their
 * figures when they end, but the scripts they run report each record as they go, which the Update tab counts while
 * a step runs. Only the current step's part is counted (after its last `step` event). Browser-safe; the reading is
 * pure.
 *
 * The update keeps these as typed events, one JSON object a line, in a file beside its log
 * (`progressFileOf`; scripts/sync/progress.ts writes them, to the file named in SYNC_PROGRESS_ENV): `step` and
 * `command` from the runner (scripts/sync/runner.ts), `record` per polled site's record in the fetch
 * (scripts/sync/polled.ts applyPoll) and through the gate (scripts/polled.ts), `admit` the admission's total
 * (scripts/polled.ts), `shots` and `shot` for other sites' images (scripts/screenshots/sites.ts). foldProgress
 * reads them; the log's wording is for people only. An update without the file (one from before 2026-10-31) shows
 * no live counts. The render step's progress isn't read here: the render run writes it to its row (`options.stages`).
 */
import { SYNC_STEPS, type SyncStepId } from './sync.js';

export interface LogProgress {
	/** The step whose events were counted (its last `step` event), or null before the first. */
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

/** Every record a site has written in the counted part, whatever its outcome. */
export const recordsSeen = (p: LogProgress | null, site: string) => Object.values(p?.sites[site] ?? {}).reduce((a, b) => a + b, 0);
