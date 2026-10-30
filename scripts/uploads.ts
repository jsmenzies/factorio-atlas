/**
 * `bun run uploads --stage local|prod [--plan] [--dry-run] [--yes] [--json]`: admit the stage's
 * 'processing' uploads (migration 0024): those over the Worker's size caps, and those the Worker couldn't
 * finish. Each goes through the same gate as in the Worker (src/lib/server/uploads/gate.ts `admitUpload`:
 * dedup's admitRecord and ingestRecord), without the caps, so it comes out live, or refused as a
 * duplicate (linking the print it copies), blocked or unreadable, as its owner then sees on
 * /uploads/<id>. One that fails here (a storage error) stays processing for the next run, until its
 * PROCESSING_ATTEMPTS-th failure marks it 'failed'. Then it puts each account's name on uploads that still
 * show an old one (a rename the account page ran out of time for), and reports the accounts whose deletion
 * is still going and the stage's `meta.ingest_due` (gate.ts) for the update's ingest key.
 *
 * The one-click update runs it as the `upload` source of its fetch step (scripts/sync/uploads.ts):
 * `--plan` lists what waits without writing, then a run admits them.
 *
 * The first SIGINT or SIGTERM stops it between uploads, the second at once. Exit 0 when done (refusals
 * included), 2 on any error or when stopped (130 on the second signal); the last line starts with ✓ or ✗.
 * With `--json` every line goes to stderr and the last stdout line is the result as JSON (`UploadsResult`),
 * whatever the outcome.
 *
 *   --plan      list the processing uploads, change nothing
 *   --dry-run   the same as --plan
 *   --yes       don't ask before writing to prod
 *   --json      the result as JSON on stdout (for the one-click update)
 */
import { writeSync } from 'node:fs';
import { admitUpload, ingestDue } from '#lib/server/uploads/gate.js';
import { admitProcessing, processingUploads, refreshUploadNames, uploadChores } from '#lib/server/uploads/uploads.js';
import { confirmProd, n, openStage, parseStageArgs, requireSchema } from './stage-command';
import { uploadsDigest, type UploadsResult } from './sync/uploads';

const USAGE = 'usage: bun run uploads --stage local|prod [--plan] [--dry-run] [--yes] [--json]';
const JSON_OUT = process.argv.includes('--json');

const result: UploadsResult = {
	ok: false,
	summary: '',
	stage: null,
	plan: process.argv.includes('--plan') || process.argv.includes('--dry-run'),
	stopped: false,
	processing: 0,
	digest: 'none',
	oldest: null,
	latest: null,
	counts: { admitted: 0, duplicate: 0, blocked: 0, undecodable: 0, failed: 0, 'gave-up': 0 },
	left: 0,
	leftDigest: 'none',
	names: { stale: 0, done: 0, left: 0 },
	deleting: 0,
	ingestDue: null
};

let lastError: string | null = null;
const toStderr = console.error.bind(console);
console.error = (...args: unknown[]) => {
	lastError = args.map(String).join(' ').split('\n')[0].replace(/^✗ /, '');
	toStderr(...args);
};
if (JSON_OUT) console.log = console.info = console.warn = toStderr;

const say = (line: string) => writeSync(JSON_OUT ? 2 : 1, `${line}\n`);
let reported = false;
const report = (ok: boolean, summary: string) => {
	if (reported) return;
	reported = true;
	Object.assign(result, { ok, summary });
	say(summary);
	if (JSON_OUT) writeSync(1, `${JSON.stringify(result)}\n`);
};
process.on('exit', (code) => {
	if (code === 0 && !reported && !result.stage) return;
	if (!reported) {
		report(
			false,
			result.stopped ? '✗ stopped before finishing; run it again to finish' : `✗ ${lastError ?? `exited (${code}) before finishing`}`
		);
	}
});

const { flags, stage, generation } = parseStageArgs(USAGE, {
	plan: { type: 'boolean', default: false },
	json: { type: 'boolean', default: false }
});
result.stage = stage;

// wrangler's platform proxy installs handlers that exit at once, so ours go on again once the stage is open.
let stopping = false;
const onSignals = () => {
	for (const sig of ['SIGINT', 'SIGTERM'] as const) {
		process.removeAllListeners(sig);
		process.on(sig, () => {
			result.stopped = true;
			if (stopping) process.exit(130);
			stopping = true;
			say(`${sig}: stopping after the current upload (again to quit now)`);
		});
	}
};
onSignals();
const target = await openStage(stage, generation);
onSignals();

let code = 0;
try {
	const db = target.env.DB;
	await requireSchema(db, stage, 'SELECT print_id FROM uploads LIMIT 0', 'uploads table', '0024');
	const waiting = await processingUploads(db);
	const chores = await uploadChores(db);
	result.processing = waiting.length;
	result.names = { stale: chores.staleNames, done: 0, left: chores.staleNames };
	result.deleting = chores.deletingAccounts;
	result.ingestDue = await ingestDue(db);
	result.digest = await uploadsDigest(waiting, chores.staleNames);
	result.oldest = waiting.length ? Math.min(...waiting.map((w) => w.updated_at)) : null;
	result.latest = waiting.length ? Math.max(...waiting.map((w) => w.updated_at)) : null;
	result.left = waiting.length;
	result.leftDigest = result.digest;
	say(
		`${stage}: ${n(waiting.length)} uploads processing, ${n(chores.staleNames)} showing an old name, ${n(chores.deletingAccounts)} accounts being deleted`
	);
	if (result.plan || result.digest === 'none') {
		report(
			true,
			result.digest === 'none'
				? '✓ no uploads processing'
				: `✓ ${n(waiting.length)} uploads would be admitted, ${n(chores.staleNames)} given their account's new name`
		);
	} else {
		await confirmProd(stage, Boolean(flags.yes), `Admit ${n(waiting.length)} processing uploads into prod?`);
		const deps = { db, raw: target.env.RAW, gate: { admit: admitUpload.bind(null, target.env) } };
		for (const { print_id } of waiting) {
			if (stopping) break;
			const r = await admitProcessing(deps, print_id);
			result.counts[r.outcome]++;
			say(`${print_id}: ${r.outcome}${r.printId ? ` (same as ${r.printId})` : ''}${r.reason ? `: ${r.reason}` : ''}`);
		}
		if (!stopping && chores.staleNames) {
			const names = await refreshUploadNames({ db, raw: target.env.RAW }, null);
			result.names = { stale: chores.staleNames, done: names.done, left: names.left };
			say(`names: ${n(names.done)} uploads given their account's new name, ${n(names.left)} left`);
		}
		const left = await processingUploads(db);
		result.left = left.length;
		result.leftDigest = await uploadsDigest(left, result.names.left);
		const c = result.counts;
		const line =
			`${n(c.admitted)} admitted, ${n(c.duplicate)} refused as duplicates, ${n(c.blocked)} blocked, ${n(c.undecodable)} unreadable, ` +
			`${n(c.failed)} failed, ${n(c['gave-up'])} given up; ${n(left.length)} still processing; ${n(result.names.done)} new names`;
		if (stopping) {
			code = 2;
			report(false, `✗ stopped: ${line}`);
		} else report(true, `✓ ${line}`);
	}
} catch (e) {
	code = 2;
	report(false, `✗ ${e instanceof Error ? e.message : String(e)}`);
} finally {
	await target.dispose();
}
process.exit(code);
