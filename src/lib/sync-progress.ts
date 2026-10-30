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
 * - the render run's phases (scripts/render-game.ts): `run <id>: …` (drawing), `rendering done; bringing N prints'
 *   thumbnails up to date` then `thumbnails: N of M prints made [and uploaded]`, `rendering done; waiting for N pages
 *   to upload`, `deletions: …`, its end line `finished: D/T pages (P/Q prints), R rendered, … F failed; …` and
 *   `uploads: N pages, …`, then `flags: render:flags --stage S…` and, if it fails, `flags: failed: …`.
 */
import { SYNC_STEPS, type SyncStepId } from './sync.js';

export interface LogProgress {
	/** The step whose part of the log was counted (its `== <label>` header), or null before the first. */
	step: SyncStepId | null;
	/** Per site, its records' outcomes in that part: `new`, `changed`, `same`, `joined`, `failed`, `undecodable`, … */
	sites: Record<string, Record<string, number>>;
	/** Per polled site, the records its admission started with. */
	toAdmit: Record<string, number>;
	/** Other sites' images: how many there were to copy, and per site those copied and failed so far. */
	shots: { toCopy: number | null; bySite: Record<string, { fetched: number; failed: number }> };
	/** The render step's run, once its runner has started (its `run <id>:` line); else null (and in every other step). */
	render: RenderLog | null;
}

/** What a render run is doing: drawing, then the work after the last page (the bar would read "done" all through it). */
export type RenderLogPhase = 'drawing' | 'thumbnails' | 'uploads' | 'deletions' | 'finishing' | 'flags';

export interface RenderLog {
	phase: RenderLogPhase;
	/** The thumb step's prints done of those offered (made, and uploaded when `upload`), from its last line. */
	thumbs: { done: number; of: number; upload: boolean } | null;
	/** Pages still to upload when drawing ended. */
	uploadsLeft: number | null;
	/** The run's end line (and its uploads line): pages drawn and failed, prints finished, pages uploaded. */
	ended: { state: string; prints: number; printsOf: number; rendered: number; failed: number; uploaded: number | null } | null;
	/** `--flags`: the stage whose search flags it is setting, and whether that failed. */
	flags: { stage: string; failed: boolean } | null;
}

const HEADER = /^== (.+)$/;
const RECORD = /^([a-z]+)\/[^\s:]+: (✗|[a-z]+)/;
const TO_ADMIT = /^\S+ ← ([a-z]+) inbox .*: ([\d,]+) records to admit/;
const SHOTS_TO_COPY = /^screenshots: [\d,]+ images from other sites shown in \S+: .*to copy ([\d,]+)/;
const SHOT = /^screenshots: ([a-z]+)\.[0-9a-f]+ \([^)]*\): (fetched|failed)/;
const RENDER_RUN = /^run \d{4}-\S+: /;
const THUMBS_START = /^rendering done; bringing [\d,]+ prints' thumbnails up to date/;
const THUMBS = /^thumbnails: ([\d,]+) of ([\d,]+) prints (made and uploaded|made)\b/;
const UPLOADS_LEFT = /^rendering done; waiting for ([\d,]+) pages to upload/;
const DELETIONS = /^deletions: /;
const RUN_END = /^(finished|stopped|failed): [\d,]+\/[\d,]+ pages \(([\d,]+)\/([\d,]+) prints\), ([\d,]+) rendered, .*?([\d,]+) failed;/;
const RUN_UPLOADS = /^uploads: ([\d,]+) pages, /;
const FLAGS = /^flags: render:flags --stage (\S+?)(?:,|$)/;
const FLAGS_FAILED = /^flags: failed/;

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
	const out: LogProgress = { step, sites: {}, toAdmit: {}, shots: { toCopy: null, bySite: {} }, render: null };
	for (let i = start; i < lines.length; i++) {
		const line = lines[i];
		if (step === 'render' && renderLine(out, line)) continue;
		let m = RECORD.exec(line);
		if (m) {
			const outcome = m[2] === '✗' ? 'failed' : m[2] === 'same' ? 'same' : m[2];
			const site = (out.sites[m[1]] ??= {});
			site[outcome] = (site[outcome] ?? 0) + 1;
			continue;
		}
		if ((m = TO_ADMIT.exec(line))) out.toAdmit[m[1]] = num(m[2]);
		else if ((m = SHOTS_TO_COPY.exec(line))) out.shots.toCopy = num(m[1]);
		else if ((m = SHOT.exec(line))) {
			const site = (out.shots.bySite[m[1]] ??= { fetched: 0, failed: 0 });
			if (m[2] === 'fetched') site.fetched++;
			else site.failed++;
		}
	}
	return out;
}

/** Reads one of the render run's phase lines into `out.render`; false for any other line. */
function renderLine(out: LogProgress, line: string): boolean {
	if (RENDER_RUN.test(line)) {
		// A new run (the step runs one; a second would start afresh).
		out.render = { phase: 'drawing', thumbs: null, uploadsLeft: null, ended: null, flags: null };
		return true;
	}
	const r = out.render;
	if (!r) return false;
	let m: RegExpExecArray | null;
	if (THUMBS_START.test(line)) r.phase = 'thumbnails';
	else if ((m = THUMBS.exec(line))) {
		r.thumbs = { done: num(m[1]), of: num(m[2]), upload: m[3] !== 'made' };
		if (r.phase === 'drawing') r.phase = 'thumbnails';
	} else if ((m = UPLOADS_LEFT.exec(line))) {
		r.phase = 'uploads';
		r.uploadsLeft = num(m[1]);
	} else if (DELETIONS.test(line)) r.phase = 'deletions';
	else if ((m = RUN_END.exec(line))) {
		r.phase = 'finishing';
		r.ended = { state: m[1], prints: num(m[2]), printsOf: num(m[3]), rendered: num(m[4]), failed: num(m[5]), uploaded: null };
	} else if ((m = RUN_UPLOADS.exec(line)) && r.ended) r.ended.uploaded = num(m[1]);
	else if ((m = FLAGS.exec(line))) {
		r.phase = 'flags';
		r.flags = { stage: m[1], failed: false };
	} else if (FLAGS_FAILED.test(line) && r.flags) r.flags.failed = true;
	else return false;
	return true;
}

/** Every record a site has written in the counted part, whatever its outcome. */
export const recordsSeen = (p: LogProgress | null, site: string) => Object.values(p?.sites[site] ?? {}).reduce((a, b) => a + b, 0);
