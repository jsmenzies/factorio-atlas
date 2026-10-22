/**
 * `bun run render` options: parsing, defaults, and `--resume` (a new run with the options the latest
 * run recorded in `render_runs.options.args`, flags given now taking precedence). Pure, for tests.
 */
import { defaultReserveMb } from './memory.js';
import { UPLOAD_TARGETS, type UploadTarget } from './upload.js';

export interface RenderArgs {
	/** Exactly one of these is the source. */
	clone: string | null;
	disk: string | null;
	ids: string[] | null;
	idsFile: string | null;
	limit: number | null;
	/** A batch: the next N prints that still have work. */
	next: number | null;
	/** Set on a run that resumes a batch: the batch's N (its prints are then `ids`). */
	batchOf: number | null;
	/**
	 * The N most-favourited prints (render_favorites) join the selection, ahead of the rest: with
	 * `--ids` the union, with `--next` a batch that takes them first, else every print. Their pages
	 * saved before 2.0 are rendered too. The stored list is refreshed from the source when it is
	 * missing or shorter than N, or with `refreshTop`.
	 */
	top: number | null;
	/** Recompute the top list from the source before the run (with `top`). */
	refreshTop: boolean;
	/** true: render every page again; 'pending': only pages a forced run left pending (a resumed `--force`). */
	force: boolean | 'pending';
	/** Queue again pages that failed every attempt at their current input. */
	retryFailed: boolean;
	planOnly: boolean;
	workers: number;
	encodeParallel: number;
	memCapMb: number;
	recycleMb: number;
	memBudgetMb: number;
	/** Start a page only while MemAvailable, less what it and the pages in flight may still grow, stays above this. */
	memReserveMb: number;
	timeoutScale: number;
	upload: UploadTarget | null;
	uploadConcurrency: number;
}

export class UsageError extends Error {}

export const USAGE =
	'usage: render --from-clone <dir> | --from-disk [dir]  [--ids a,b | --ids-file f] [--limit N | --next N] [--top N [--refresh-top]]\n' +
	'              [--force] [--retry-failed]\n' +
	'              [--plan-only] [--upload local|prod] [--upload-concurrency N]\n' +
	'              [--workers N] [--encode-parallel N] [--mem-cap-mb N] [--recycle-mb N] [--mem-budget-mb N]\n' +
	'              [--mem-reserve-mb N] [--timeout-scale X]\n' +
	'       render --resume [any flag above, to override]';

export const defaultArgs = (machine: { threads: number; ramMb: number }): Omit<RenderArgs, 'clone' | 'disk'> => ({
	ids: null,
	idsFile: null,
	limit: null,
	next: null,
	batchOf: null,
	top: null,
	refreshTop: false,
	force: false,
	retryFailed: false,
	planOnly: false,
	workers: Math.max(1, Math.floor(machine.threads / 2)),
	encodeParallel: 4,
	memCapMb: 6144,
	recycleMb: 3072,
	memBudgetMb: Math.round(machine.ramMb * 0.7),
	memReserveMb: defaultReserveMb(machine.ramMb),
	timeoutScale: 1,
	upload: null,
	uploadConcurrency: 32
});

const NUMBERS = {
	'--workers': 'workers',
	'--encode-parallel': 'encodeParallel',
	'--mem-cap-mb': 'memCapMb',
	'--recycle-mb': 'recycleMb',
	'--mem-budget-mb': 'memBudgetMb',
	'--mem-reserve-mb': 'memReserveMb',
	'--timeout-scale': 'timeoutScale',
	'--upload-concurrency': 'uploadConcurrency',
	'--limit': 'limit',
	'--next': 'next',
	'--top': 'top'
} as const satisfies Record<string, keyof RenderArgs>;
const INTEGER = new Set<keyof RenderArgs>(['workers', 'encodeParallel', 'uploadConcurrency', 'limit', 'next', 'top']);

/** The flags given, and whether `--resume` was one. `defaultDisk` is `--from-disk`'s folder when none follows it. */
export function parseArgs(argv: string[], defaultDisk: string): { given: Partial<RenderArgs>; resume: boolean } {
	const a = [...argv];
	const given: Partial<RenderArgs> = {};
	let resume = false;
	const value = (name: string) => {
		const v = a.shift();
		if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} needs a value`);
		return v;
	};
	while (a.length) {
		const arg = a.shift()!;
		if (arg === '--resume') resume = true;
		else if (arg === '--force') given.force = true;
		else if (arg === '--retry-failed') given.retryFailed = true;
		else if (arg === '--plan-only') given.planOnly = true;
		else if (arg === '--refresh-top') given.refreshTop = true;
		else if (arg === '--from-clone') given.clone = value(arg);
		else if (arg === '--from-disk') given.disk = a[0] && !a[0].startsWith('--') ? a.shift()! : defaultDisk;
		else if (arg === '--ids') {
			given.ids = value(arg)
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
		} else if (arg === '--ids-file') given.idsFile = value(arg);
		else if (arg === '--upload') {
			const t = value(arg);
			if (!(UPLOAD_TARGETS as readonly string[]).includes(t)) throw new UsageError(`--upload must be one of ${UPLOAD_TARGETS.join(', ')}`);
			given.upload = t as UploadTarget;
		} else if (arg in NUMBERS) {
			const key = NUMBERS[arg as keyof typeof NUMBERS];
			const n = Number(value(arg));
			if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${arg} must be a positive number`);
			(given as Record<string, number>)[key] = INTEGER.has(key) ? Math.round(n) : n;
		} else throw new UsageError(`unknown argument: ${arg}`);
	}
	return { given, resume };
}

/** Flags given now replace what they stand for: a new source replaces the old, a new selection the old one. */
export function mergeArgs(base: RenderArgs, given: Partial<RenderArgs>): RenderArgs {
	const out: RenderArgs = { ...base, ...given };
	if (given.clone !== undefined) out.disk = null;
	if (given.disk !== undefined) out.clone = null;
	if (
		given.ids !== undefined ||
		given.idsFile !== undefined ||
		given.next !== undefined ||
		given.limit !== undefined ||
		given.top !== undefined
	) {
		out.ids = given.ids ?? null;
		out.idsFile = given.idsFile ?? null;
		out.next = given.next ?? null;
		out.limit = given.limit ?? null;
		out.top = given.top ?? null;
		out.batchOf = null;
	}
	if (out.top === null) out.refreshTop = false;
	return out;
}

/** Fill in defaults and check the combination. */
export function resolveArgs(given: Partial<RenderArgs>, defaults: Omit<RenderArgs, 'clone' | 'disk'>): RenderArgs {
	const args: RenderArgs = { clone: null, disk: null, ...defaults, ...given };
	validate(args);
	return args;
}

export function validate(args: RenderArgs) {
	if (!args.clone === !args.disk) throw new UsageError('pick one source: --from-clone <dir> or --from-disk [dir]');
	if (args.ids && args.idsFile) throw new UsageError('pick one of --ids and --ids-file');
	if (args.next !== null && args.limit !== null) throw new UsageError('pick one of --limit and --next');
	if (args.refreshTop && args.top === null) throw new UsageError('--refresh-top needs --top N');
	if (args.planOnly && args.upload) throw new UsageError('--plan-only renders nothing, so it uploads nothing: drop --upload');
}

/** What the latest run recorded about its batch (`--next`). */
export interface BatchRecord {
	next: number;
	/** Prints taken so far, in order. */
	picked: string[];
	/** Every print was looked at (the batch is final): a resume renders exactly these. */
	complete: boolean;
	/** Prints that may have work left when the batch started, and how many of them were never looked at. */
	candidates?: number;
	unseen?: number;
	/** Candidates not looked at by the end of the pick: roughly the prints left after this batch. */
	left?: number;
}

export interface RecordedOptions {
	args?: RenderArgs;
	batch?: BatchRecord;
}

/**
 * The args for `--resume`: the latest run's, so the new run carries on where it stopped. A forced run
 * resumes forcing only the pages it hadn't reached; a batch whose prints were all picked resumes with
 * exactly those prints (an unfinished pick is simply picked again); `--plan-only` and `--retry-failed`
 * are dropped (the pages it queued again are pending, so the resume renders them anyway).
 */
export function resumeArgs(recorded: RecordedOptions, runId: string, given: Partial<RenderArgs>): { args: RenderArgs; summary: string } {
	const base = recorded.args;
	if (!base)
		throw new UsageError(`the latest render run (${runId}) has no recorded options to resume (it predates --resume); run with flags`);
	// Runs recorded before --top existed have neither field.
	let args: RenderArgs = {
		...base,
		top: base.top ?? null,
		refreshTop: false,
		planOnly: false,
		retryFailed: false,
		force: base.force ? 'pending' : false
	};
	let summary = `resuming run ${runId}`;
	if (base.next !== null && recorded.batch?.complete) {
		// The picks already hold the top-list prints it took: exactly those, no list added again.
		args = { ...args, ids: recorded.batch.picked, idsFile: null, next: null, top: null, batchOf: base.next };
		summary += `: its batch of ${base.next} (${recorded.batch.picked.length} prints${base.top ? `, with the top ${base.top} first` : ''})`;
	} else if (base.next !== null) summary += `: a batch of ${base.next}, picked again (its pick wasn't finished)`;
	else if (base.batchOf !== null) summary += `: its batch of ${base.batchOf} (${base.ids?.length ?? 0} prints)`;
	if (base.force) summary += '; pages its --force left pending are rendered again';
	args = mergeArgs(args, given);
	if (given.force) args.force = true;
	validate(args);
	return { args, summary };
}

/** The command line these args stand for, for logs. */
export function commandLine(a: RenderArgs): string {
	const parts: string[] = [];
	if (a.clone) parts.push('--from-clone', a.clone);
	if (a.disk) parts.push('--from-disk', a.disk);
	if (a.ids) parts.push('--ids', a.ids.length > 5 ? `<${a.ids.length} ids>` : a.ids.join(','));
	if (a.idsFile) parts.push('--ids-file', a.idsFile);
	if (a.limit !== null) parts.push('--limit', String(a.limit));
	if (a.next !== null) parts.push('--next', String(a.next));
	if (a.top !== null) parts.push('--top', String(a.top));
	if (a.refreshTop) parts.push('--refresh-top');
	if (a.force === true) parts.push('--force');
	if (a.force === 'pending') parts.push('(--force for pages left pending)');
	if (a.retryFailed) parts.push('--retry-failed');
	if (a.planOnly) parts.push('--plan-only');
	if (a.upload) parts.push('--upload', a.upload);
	parts.push('--workers', String(a.workers));
	return parts.join(' ');
}
