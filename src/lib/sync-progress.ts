/**
 * Live progress of a running update, read from its log (the dev plugin's `/admin/__sync/log?progress=1`):
 * the steps only record their figures when they end, but the scripts they run write one line per record,
 * which the Update tab counts while a step runs. Only the current step's part of the log (after its last
 * `== <step label>` header) is counted. Browser-safe; the parsing is pure.
 *
 * Lines it reads (each written by one script; keep them in step):
 * - `codex/494: new`, `fprints/<uuid>: undecodable (…)`, `codex/323: failed (…)`, `codex/12: ✗ …`: a polled
 *   site's record, in the fetch (scripts/sync/polled.ts applyPoll) or through the gate (scripts/polled.ts);
 * - `prod ← codex inbox …: 431 records to admit, 0 gone from the site`: the admission's total (scripts/polled.ts);
 * - `screenshots: 749 images from other sites shown in prod: … to copy 716 → …`: other sites' images to copy, and
 *   `screenshots: codex.<hex> (<print>): fetched` or `: failed (…)` per image (scripts/screenshots/sites.ts);
 * - `$ bun scripts/screenshots.ts --from-sites prod --json`: the command the step runs now (scripts/sync/runner.ts).
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

const HEADER = /^== (.+)$/;
const RECORD = /^([a-z]+)\/[^\s:]+: (✗|[a-z]+)/;
const TO_ADMIT = /^\S+ ← ([a-z]+) inbox .*: ([\d,]+) records to admit/;
const SHOTS_TO_COPY = /^screenshots: [\d,]+ images from other sites shown in \S+: .*to copy ([\d,]+)/;
const SHOT = /^screenshots: ([a-z]+)\.[0-9a-f]+ \([^)]*\): (fetched|failed)/;
const COMMAND = /^\$ bun (.+)$/;

const num = (s: string) => Number(s.replace(/,/g, ''));

/** Counts the current step's part of a log (its tail is enough when it holds that step's header). */
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
	const out: LogProgress = { step, sites: {}, toAdmit: {}, shots: { toCopy: null, bySite: {}, last: null }, command: null };
	for (let i = start; i < lines.length; i++) {
		const line = lines[i];
		let m = RECORD.exec(line);
		if (m) {
			const outcome = m[2] === '✗' ? 'failed' : m[2] === 'same' ? 'same' : m[2];
			const site = (out.sites[m[1]] ??= {});
			site[outcome] = (site[outcome] ?? 0) + 1;
			continue;
		}
		if ((m = COMMAND.exec(line))) out.command = m[1];
		else if ((m = TO_ADMIT.exec(line))) out.toAdmit[m[1]] = num(m[2]);
		else if ((m = SHOTS_TO_COPY.exec(line))) out.shots.toCopy = num(m[1]);
		else if ((m = SHOT.exec(line))) {
			const site = (out.shots.bySite[m[1]] ??= { fetched: 0, failed: 0 });
			if (m[2] === 'fetched') site.fetched++;
			else site.failed++;
			out.shots.last = m[1];
		}
	}
	return out;
}

/** Every record a site has written in the counted part, whatever its outcome. */
export const recordsSeen = (p: LogProgress | null, site: string) => Object.values(p?.sites[site] ?? {}).reduce((a, b) => a + b, 0);
