/**
 * `bun run screenshots` options and settings. Pure, for tests.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { UPLOAD_TARGETS, type UploadTarget } from './ledger.js';
import { isPrintId } from '#lib/print-id.js';
import { IMGUR_ID, isOwnImage } from '#lib/screenshots.js';

/** Sent with every request; no Referer is ever sent (Imgur refuses some). */
export const USER_AGENT = 'BlueprintAtlas-screenshots/1.0 (+https://github.com/jsmenzies/factorio-atlas)';
/** Requests started per second, at most (default; `--rate`, up to MAX_RATE). */
export const RATE_PER_S = 4;
/** Requests in flight, at most (default; `--in-flight`, up to MAX_IN_FLIGHT). */
export const IN_FLIGHT = 4;
export const MAX_RATE = 20;
export const MAX_IN_FLIGHT = 32;
export const TIMEOUT_MS = 60_000;
/** Tries per image within a run, for 5xx, timeouts and network errors. */
export const ATTEMPTS = 3;

/**
 * Fetched before every run: if Imgur no longer serves these exact bytes for it, it is serving
 * something else (a regional placeholder, a block page) and the run stops before storing anything.
 * The run's own oldest fetched image is used instead once there is one.
 */
export const CANARY = { id: '8B9jpx6', ext: 'jpg', md5: '58b12b0030452ea6180f464efe5ca515' } as const;
/** The canary is fetched again after every this many stored images; a failure stops the run. */
export const CANARY_EVERY = 500;
/** Whether the image just stored, the `fetched`th of the run, is due a canary check. */
export const canaryDue = (fetched: number, every = CANARY_EVERY) => fetched > 0 && fetched % every === 0;

const expand = (root: string, dir: string) => resolve(root, dir === '~' || dir.startsWith('~/') ? join(homedir(), dir.slice(1)) : dir);

/** SCREENSHOTS_DIR (`~/` expanded, relative to `root`), or `<root>/data/screenshots`. */
export const screenshotsDir = (root = process.cwd(), value = process.env.SCREENSHOTS_DIR) => {
	const dir = value?.trim();
	return dir ? expand(root, dir) : join(root, 'data', 'screenshots');
};

/**
 * fetch (default): copy originals from Imgur. uploads: copy a stage's approved upload screenshots from
 * its RAW bucket. sites: copy the images other sites' records name (codex's), for a stage's prints that show
 * them (scripts/screenshots/sites.ts). make: the sizes, from the originals on disk. upload: make what's missing, then bring a
 * bucket in line. recheck: ask Imgur whether copied images still exist, and mark the deleted ones removed.
 */
export type Mode = 'fetch' | 'uploads' | 'sites' | 'make' | 'upload' | 'recheck';

/** Images made or uploaded at once (`--jobs`). */
export const JOBS = 6;

export interface ShotArgs {
	mode: Mode;
	/** For `upload`: the bucket; for `uploads` and `sites`: the stage whose prints' images to copy. */
	target: UploadTarget | null;
	jobs: number;
	clone: string;
	/** Also read raw records from this folder, for prints the clone lacks. */
	disk: string | null;
	/** Print ids and image ids (Imgur's, or `upload.<16 hex>`; told apart by their shape). */
	ids: string[] | null;
	limit: number | null;
	/** Requests started per second, at most. */
	rate: number;
	/** Requests in flight, at most. */
	inFlight: number;
	recheckDead: boolean;
	planOnly: boolean;
	canary: boolean;
	/** End the fetch or the upload with its counts as one line of JSON on stdout. */
	json: boolean;
}

export class UsageError extends Error {}

const MODE_FLAG: Record<Mode, string> = {
	fetch: 'the fetch',
	uploads: '--from-uploads',
	sites: '--from-sites',
	make: '--make',
	upload: '--upload',
	recheck: '--recheck'
};

export const USAGE =
	'usage: screenshots [--from-clone DIR] [--from-disk [DIR]] [--ids a,b] [--limit N] [--rate N] [--in-flight N]\n' +
	'                   [--recheck-dead] [--plan-only] [--no-canary] [--json]\n' +
	'       screenshots --from-uploads local|prod [--ids a,b] [--limit N] [--plan-only] [--json]\n' +
	'       screenshots --from-sites local|prod [--ids a,b] [--limit N] [--plan-only] [--json]\n' +
	'       screenshots --make [--ids a,b] [--limit N] [--jobs N]\n' +
	'       screenshots --upload local|prod [--ids a,b] [--limit N] [--jobs N] [--plan-only] [--json]\n' +
	'       screenshots --recheck [--ids a,b] [--limit N] [--rate N] [--no-canary]';

export function parseArgs(argv: readonly string[], defaults: { clone: string; disk: string; root?: string }): ShotArgs {
	const root = defaults.root ?? process.cwd();
	const a: ShotArgs = {
		mode: 'fetch',
		target: null,
		jobs: JOBS,
		clone: expand(root, defaults.clone),
		disk: null,
		ids: null,
		limit: null,
		rate: RATE_PER_S,
		inFlight: IN_FLIGHT,
		recheckDead: false,
		planOnly: false,
		json: false,
		canary: true
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = () => {
			const v = argv[++i];
			if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
			return v;
		};
		if (flag === '--from-clone') a.clone = expand(root, value());
		else if (flag === '--from-disk')
			a.disk = expand(root, argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : defaults.disk);
		else if (flag === '--ids') {
			const ids = value()
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			const bad = ids.filter((id) => !isPrintId(id) && !IMGUR_ID.test(id) && !isOwnImage(id));
			if (bad.length) throw new UsageError(`not a print, Imgur, upload or site image id: ${bad.join(', ')}`);
			a.ids = [...new Set([...(a.ids ?? []), ...ids])];
		} else if (flag === '--limit') {
			const n = Number(value());
			if (!Number.isInteger(n) || n < 1) throw new UsageError('--limit takes a whole number above 0');
			a.limit = n;
		} else if (flag === '--rate') {
			const n = Number(value());
			if (!Number.isFinite(n) || n <= 0 || n > MAX_RATE) throw new UsageError(`--rate takes a number above 0, at most ${MAX_RATE}`);
			a.rate = n;
		} else if (flag === '--in-flight') {
			const n = Number(value());
			if (!Number.isInteger(n) || n < 1 || n > MAX_IN_FLIGHT)
				throw new UsageError(`--in-flight takes a whole number from 1 to ${MAX_IN_FLIGHT}`);
			a.inFlight = n;
		} else if (flag === '--make' || flag === '--recheck' || flag === '--upload' || flag === '--from-uploads' || flag === '--from-sites') {
			const mode = (flag === '--from-uploads' ? 'uploads' : flag === '--from-sites' ? 'sites' : flag.slice(2)) as Mode;
			if (a.mode !== 'fetch' && a.mode !== mode) throw new UsageError(`${MODE_FLAG[a.mode]} and ${flag} don't go together`);
			a.mode = mode;
			if (flag === '--upload' || flag === '--from-uploads' || flag === '--from-sites') {
				const t = value();
				if (!(UPLOAD_TARGETS as readonly string[]).includes(t)) throw new UsageError(`${flag} takes ${UPLOAD_TARGETS.join(' or ')}`);
				a.target = t as UploadTarget;
			}
		} else if (flag === '--jobs') {
			const n = Number(value());
			if (!Number.isInteger(n) || n < 1 || n > 64) throw new UsageError('--jobs takes a whole number from 1 to 64');
			a.jobs = n;
		} else if (flag === '--recheck-dead') a.recheckDead = true;
		else if (flag === '--plan-only') a.planOnly = true;
		else if (flag === '--json') a.json = true;
		else if (flag === '--no-canary') a.canary = false;
		else throw new UsageError(`unknown option ${flag}`);
	}
	return a;
}
