/**
 * Uploads as a source of the one-click update (plans: ingest and delete): the stage's 'processing' uploads
 * (over the Worker's size caps, or the Worker couldn't finish), admitted by scripts/uploads.ts through the
 * same gate as in the Worker, without its caps.
 *
 * - plan: `uploads --plan`: how many wait; the cursor is a digest of them ('none' when none wait), dated by
 *   the oldest waiting upload's last change.
 * - apply: `uploads --yes`: admit them; the cursor is a digest of those still processing (failed ones,
 *   left for the next update), and `counts` says how each came out (the update's `sources` JSON).
 *
 * Uploads that went live in the Worker need nothing here: they are ingested already. Each call is a child
 * process (the stage's bindings: prod through the backfill's Node sidecar), its stderr into the update's.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { SourceCursor, SourcePlan } from '#lib/sync.js';
import type { ProcessingOutcome } from '#lib/server/uploads/uploads.js';
import type { SourceAdapter } from './mirror';
import { lastJsonLine } from './output';

/** The update's name for this source (its `sources` entry and the Overview's row); print_sources calls the site 'upload'. */
export const UPLOADS_SOURCE = 'uploads';

/** scripts/uploads.ts's `--json` result: its last stdout line. */
export interface UploadsResult {
	ok: boolean;
	/** The ✓ or ✗ line. */
	summary: string;
	stage: string | null;
	plan: boolean;
	stopped: boolean;
	/** Processing uploads when it started, and a digest of them and the names to update (`none` when neither): the update's cursor. */
	processing: number;
	digest: string;
	/** The oldest and latest change among them (unix ms), or null. */
	oldest: number | null;
	latest: number | null;
	counts: Record<ProcessingOutcome, number>;
	/** Still processing at the end (failed or not reached), and their digest. */
	left: number;
	leftDigest: string;
	/** Uploads still showing an old name: when it started, put right (`done`), and still to do. */
	names: { stale: number; done: number; left: number };
	/** Accounts whose deletion is still going (users.deleting_at). */
	deleting: number;
	/** The stage's `meta.ingest_due` (uploads/gate.ts), for the ingest key. */
	ingestDue: string | null;
}

/**
 * A short fingerprint of a set of uploads and their last changes, and of how many uploads show an old name:
 * it moves whenever one is added, changed or goes. 'none' when there's nothing to do.
 */
export const uploadsDigest = async (rows: readonly { print_id: string; updated_at: number }[], staleNames = 0) => {
	if (!rows.length && !staleNames) return 'none';
	const text = [...rows.map((r) => `${r.print_id}:${r.updated_at}`), `names:${staleNames}`].join('\n');
	const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
	return `${rows.length}-${Array.from(hash.slice(0, 6), (b) => b.toString(16).padStart(2, '0')).join('')}`;
};

const NONE: SourceCursor = { id: 'none', date: 0 };

const when = (ms: number) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const plural = (n: number, one: string) => `${n.toLocaleString('en')} ${one}${n === 1 ? '' : 's'}`;

/** The Overview's line for the uploads source (SourcePlan.position), and its state when there's work (stateText). */
export const uploadsLines = (r: Pick<UploadsResult, 'processing' | 'oldest' | 'names' | 'deleting'>) => {
	const parts = [
		r.processing ? `${r.processing.toLocaleString('en')} waiting, oldest ${when(r.oldest ?? 0)}` : 'none waiting',
		...(r.names.stale ? [`${plural(r.names.stale, 'upload')} to show a new name`] : []),
		...(r.deleting ? [`${plural(r.deleting, 'account')} being deleted`] : [])
	];
	const work = [
		...(r.processing ? [`${r.processing.toLocaleString('en')} waiting`] : []),
		...(r.names.stale ? [plural(r.names.stale, 'name')] : [])
	];
	return { position: parts.join(' · '), stateText: work.length ? work.join(', ') : undefined };
};

/** `bun scripts/uploads.ts --stage <stage> …args --json`: its result, or throw with its ✗ line. */
const runUploads = (root: string, stage: string, args: string[], signal?: AbortSignal) =>
	new Promise<UploadsResult>((resolve, reject) => {
		const child = spawn(process.execPath, [join(root, 'scripts', 'uploads.ts'), '--stage', stage, ...args, '--json'], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'inherit'],
			signal
		});
		let out = '';
		child.stdout.on('data', (b: Buffer) => (out += b.toString()));
		child.on('error', reject);
		child.on('close', (code) => {
			const r = lastJsonLine<UploadsResult>(out);
			if (r?.ok) resolve(r);
			else reject(new Error(r?.summary.replace(/^✗ /, '') ?? `uploads exited ${code}`));
		});
	});

export const uploadsSource = (root: string, stage: string): SourceAdapter => ({
	site: UPLOADS_SOURCE,
	ingestsItself: true,
	plan: async ({ signal }): Promise<SourcePlan> => {
		const r = await runUploads(root, stage, ['--plan'], signal);
		return {
			site: UPLOADS_SOURCE,
			kind: 'uploads on the site',
			ingestsItself: true,
			...uploadsLines(r),
			ingestDue: r.ingestDue,
			from: NONE,
			to: r.digest === 'none' ? NONE : { id: r.digest, date: r.oldest ?? Date.now() },
			prints: r.processing,
			added: r.processing,
			edited: 0,
			favourites: 0,
			deleted: [],
			modern: 0,
			blocked: null
		};
	},
	apply: async (_plan, signal) => {
		const r = await runUploads(root, stage, ['--yes'], signal);
		return {
			...(r.leftDigest === 'none' ? NONE : { id: r.leftDigest, date: Date.now() }),
			counts: {
				admitted: r.counts.admitted,
				duplicate: r.counts.duplicate,
				blocked: r.counts.blocked,
				unreadable: r.counts.undecodable,
				failed: r.counts.failed,
				'gave up': r.counts['gave-up'],
				left: r.left,
				renamed: r.names.done,
				'names left': r.names.left,
				deleting: r.deleting
			}
		};
	}
});
