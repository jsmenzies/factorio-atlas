/**
 * `bun run polled --stage local|prod --site codex [--dir DIR] [--dry-run] [--force] [--yes] [--json]`: give
 * the stage what a polled site's inbox holds (scripts/sync/polled.ts): every record at a revision the stage
 * wasn't given goes through the one gate (`admitRecord`, then `ingestRecord`, in Bun with no Worker caps),
 * (`addRecord`, add-record.ts, with `update` for records the site changed), so blocks, joins (the same
 * blueprint already here: first upload wins what is shown) and suggestions apply
 * as for any record; every print the site deleted is a source gone (`sourceGone`): it stays while another
 * source has it, else it is purged as 'gone'.
 *
 * The one-click update runs it in its ingest step, after the backfill, for each polled site that is on. When
 * it wrote, the record store's copy of the site is pulled from the stage (records/polled.ts), so the render
 * step that follows draws the new prints.
 *
 * A purge from here deletes the stage's rows and RAW objects and bumps the page cache; the print's render
 * files in the stage's RENDERS bucket go with the next `bun run removals` (the update's first step), which
 * sweeps every tombstoned print. Polled prints have no screenshot of ours yet (codex.ts, the image hook).
 *
 * What each stage was given: `<inbox>/<site>/.admitted.<stage>.json`; a record that fails (storage) is not
 * marked and is tried again next run. Refused records (blocked, unreadable) are marked: tried again only
 * when they change.
 *
 *   --dir DIR   the record store (default RECORDS_DIR, else ~/data/factorio-records); the inbox is DIR/.polled
 *   --dry-run   admitRecord only (D1 reads): say what each record would be, write nothing
 *   --force     every inbox record again, whatever the stage was given
 *   --yes       don't ask before writing to prod
 *   --json      the result as JSON on stdout (`PolledAdmitResult`); every other line to stderr
 *
 * Exit 0 when done (refusals included), 2 on any error or when stopped (130 on the second signal); the last
 * line starts with ✓ or ✗.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeSync } from 'node:fs';
import { Effect, Layer } from 'effect';
import { printIdFor } from '#lib/print-id.js';
import { addRecord } from '#lib/server/pipeline/add-record.js';
import { admitRecord, type Suggestion } from '#lib/server/pipeline/admit.js';
import { OFFLINE_MAX_INFLATED_BYTES } from '#lib/server/pipeline/decode.js';
import type { PrintSourceRow } from '#lib/server/pipeline/identity-db.js';
import { ingestRecord, syncFold, syncSources } from '#lib/server/pipeline/pipeline.js';
import { RawStoreR2 } from '#lib/server/pipeline/raw-store.js';
import { PrintRepository, PrintRepositoryD1 } from '#lib/server/pipeline/repository.js';
import { sourceGone } from '#lib/server/pipeline/source-gone.js';
import { mirrorPath } from '#lib/server/pipeline/source.js';
import { fromFactorioprints, fromPipelineText, rawKeyFor, type SourceRecord } from '#lib/server/pipeline/source-record.js';
import { purgePrintData, type TakedownEnv } from '#lib/server/takedown.js';
import { markIngestDue } from '#lib/server/uploads/gate.js';
import { POLLED_SITES } from '#lib/sync.js';
import { recordsDir, readStoreRecord } from './records/store';
import { polledStoreAdapter } from './records/polled';
import { pullSite, type PullCounts } from './records/pull';
import { confirmProd, n, openStage, parseStageArgs, requireSchema } from './stage-command';
import { admissionWork, inboxDir, readLedger, readState, writeLedger } from './sync/polled';

const USAGE = 'usage: bun run polled --stage local|prod --site <site> [--dir DIR] [--dry-run] [--force] [--yes] [--json]';
const JSON_OUT = process.argv.includes('--json');

export type AdmitOutcome =
	/** A print of its own. */
	| 'new'
	/** The same blueprint was here already (whole-print exact hash): this record joined that print. */
	| 'joined'
	/** Its own print, changed. */
	| 'updated'
	| 'unchanged'
	/** Its print shows an earlier source's record: only its source row and hashes were written. */
	| 'identified'
	| 'blocked'
	| 'undecodable'
	/** Storage or the like: tried again next run. */
	| 'failed';

export interface PolledAdmitResult {
	ok: boolean;
	summary: string;
	stage: string | null;
	site: string;
	dryRun: boolean;
	stopped: boolean;
	/** Records the stage wasn't given at their revision, and gone prints it still had, when it started. */
	waiting: number;
	goneWaiting: number;
	counts: Record<AdmitOutcome, number>;
	/** Gone prints: purged (no source left), kept (another source has them), handed over (another source now credited). */
	gone: { purged: number; kept: number; handedOver: number; failed: number };
	/** Records whose answer carried suggestions (never joins), and the suggestions by kind. */
	suggested: number;
	/** Of the new prints, those with suggestions: a near match for an admin to look at, never joined. */
	suggestedNew: number;
	suggestions: Record<string, number>;
	/** Joined records: site id → the print they joined. */
	joins: Record<string, string>;
	/** Whether the stage was written (prints admitted, changed or purged). */
	wrote: boolean;
	/** The record store's pull of this site afterwards (records/polled.ts), when the stage was written: what the render step draws. */
	store: PullCounts | null;
}

const result: PolledAdmitResult = {
	ok: false,
	summary: '',
	stage: null,
	site: '',
	dryRun: false,
	stopped: false,
	waiting: 0,
	goneWaiting: 0,
	counts: { new: 0, joined: 0, updated: 0, unchanged: 0, identified: 0, blocked: 0, undecodable: 0, failed: 0 },
	gone: { purged: 0, kept: 0, handedOver: 0, failed: 0 },
	suggested: 0,
	suggestedNew: 0,
	suggestions: {},
	joins: {},
	wrote: false,
	store: null
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
	if (!reported) report(false, result.stopped ? '✗ stopped before finishing' : `✗ ${lastError ?? `exited (${code}) before finishing`}`);
});

const { flags, stage, generation } = parseStageArgs(USAGE, {
	site: { type: 'string' },
	dir: { type: 'string' },
	force: { type: 'boolean', default: false },
	json: { type: 'boolean', default: false }
});
const site = POLLED_SITES.find((p) => p.site === flags.site)?.site;
if (!site) {
	console.error(`--site must be one of ${POLLED_SITES.map((p) => p.site).join(', ')}\n${USAGE}`);
	process.exit(2);
}
result.stage = stage;
result.site = site;
result.dryRun = Boolean(flags['dry-run']);
const storeDir = flags.dir ? resolve(flags.dir) : recordsDir();
const inbox = inboxDir(storeDir);

let stopping = false;
const onSignals = () => {
	for (const sig of ['SIGINT', 'SIGTERM'] as const) {
		process.removeAllListeners(sig);
		process.on(sig, () => {
			result.stopped = true;
			if (stopping) process.exit(130);
			stopping = true;
			say(`${sig}: stopping after the current record (again to quit now)`);
		});
	}
};
onSignals();
const target = await openStage(stage, generation);
onSignals();

const reasonOf = (e: unknown) => (e instanceof Error ? e.message || e.name : String(e)) || 'unknown error';
const tally = (s: readonly Suggestion[], outcome: AdmitOutcome) => {
	if (!s.length) return;
	result.suggested++;
	if (outcome === 'new') result.suggestedNew++;
	for (const x of s) result.suggestions[x.kind] = (result.suggestions[x.kind] ?? 0) + 1;
};
/**
 * A throw here is storage (a record's own problems are outcomes), and the local D1 is one SQLite file the
 * update's runner writes too, whose busy answers can come without a message: worth a few more tries.
 */
const TRIES = 4;
const NO_RECORD = 'no record in the inbox';

/**
 * Bun's stand-in for the purge's buckets: RENDERS and SCREENSHOTS aren't bound outside the Worker. Nothing is
 * listed there, so nothing is deleted; the next `removals` run sweeps the tombstoned print's renders from the
 * stage's bucket (through R2's S3 API). No edge purge (no RENDERS_URL): cached render files name the print's
 * own id, whose pages answer 410 once the tombstone is in.
 */
const noBucket = {
	list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }),
	delete: async () => undefined,
	put: async () => null,
	get: async () => null,
	head: async () => null
} as unknown as R2Bucket;

let code = 0;
try {
	const env = target.env;
	const db = env.DB;
	await requireSchema(db, stage, 'SELECT site FROM print_sources LIMIT 0', 'print_sources table', '0022');
	const state = await readState(inbox, site);
	const ledger = await readLedger(inbox, site, stage);
	const work = admissionWork(state, ledger, Boolean(flags.force));
	result.waiting = work.records.length;
	result.goneWaiting = work.gone.length;
	say(
		`${stage} ← ${site} inbox ${join(inbox, site)}: ${n(work.records.length)} records to admit, ${n(work.gone.length)} gone from the site`
	);
	if (!result.dryRun && (work.records.length || work.gone.length))
		await confirmProd(stage, Boolean(flags.yes), `Admit ${n(work.records.length)} ${site} records into prod?`);

	const layer = Layer.mergeAll(RawStoreR2(env.RAW), PrintRepositoryD1(db));
	const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) => Effect.runPromise(Effect.provide(effect, layer));
	const opts = { maxInflatedBytes: OFFLINE_MAX_INFLATED_BYTES };
	let sinceSave = 0;
	const save = async (force = false) => {
		if (result.dryRun) return;
		if (force || ++sinceSave >= 25) {
			sinceSave = 0;
			await writeLedger(inbox, site, stage, ledger);
		}
	};

	/** One inbox record through the gate (admitRecord, then ingestRecord); throws on storage errors. */
	/** One inbox record through the gate (addRecord: admitRecord, then ingestRecord); throws on storage errors. */
	const admitOne = async (siteId: string, printId: string): Promise<{ outcome: AdmitOutcome; note: string }> => {
		const record = await readStoreRecord(inbox, printId);
		if (!record) throw new Error(NO_RECORD);
		const r = await addRecord(env, record, { plan: result.dryRun, update: true, maxInflatedBytes: OFFLINE_MAX_INFLATED_BYTES });
		if (r.status === 'failed') throw new Error(r.reason);
		if (r.status === 'new' || r.status === 'joins') tally(r.suggestions, r.status === 'new' ? 'new' : 'joined');
		switch (r.status) {
			case 'new':
				return { outcome: 'new', note: '' };
			case 'joins':
				result.joins[siteId] = r.printId;
				return { outcome: 'joined', note: `${r.printId}${r.shown ? ', shown: posted first' : ''}` };
			case 'already':
				return { outcome: r.updated ? 'updated' : 'unchanged', note: r.printId };
			case 'blocked':
				return { outcome: 'blocked', note: r.by };
			case 'unreadable':
				return { outcome: 'undecodable', note: r.reason };
			case 'too-big':
				return { outcome: 'undecodable', note: `too big (${r.by})` };
		}
	};

	for (const siteId of work.records) {
		if (stopping) break;
		const rev = state.records[siteId].rev;
		const printId = printIdFor(site, siteId);
		let outcome: AdmitOutcome = 'failed';
		let note = '';
		for (let attempt = 1; attempt <= TRIES; attempt++) {
			try {
				({ outcome, note } = await admitOne(siteId, printId));
				ledger.records[siteId] = rev;
				break;
			} catch (e) {
				outcome = 'failed';
				note = reasonOf(e);
				if (note === NO_RECORD || attempt === TRIES) break;
				await new Promise((r) => setTimeout(r, 500 * attempt + Math.random() * 500));
			}
		}
		result.counts[outcome]++;
		if (!result.dryRun && outcome !== 'failed' && outcome !== 'blocked' && outcome !== 'undecodable' && outcome !== 'unchanged')
			result.wrote = true;
		say(`${site}/${siteId}: ${outcome}${note ? ` (${note})` : ''}`);
		await save();
	}

	// The site deleted these: a source gone. A factorioprints source taking over is read from the mirror clone.
	const clone = process.env.RENDER_CLONE_DIR || join(homedir(), 'data', 'factorio-mirror');
	const takedownEnv: TakedownEnv = { DB: db, RAW: env.RAW, RENDERS: noBucket, SCREENSHOTS: noBucket, RENDERS_URL: '', SCREENSHOTS_URL: '' };
	const reingest = async (printId: string, winner: PrintSourceRow) => {
		let record: SourceRecord | null;
		if (winner.site === 'factorioprints')
			record = fromFactorioprints(winner.site_id, await readFile(join(clone, mirrorPath(winner.site_id)), 'utf8'));
		else {
			const obj = await env.RAW.get(rawKeyFor(winner.site, winner.site_id));
			record = obj ? fromPipelineText(await obj.text()) : null;
		}
		if (!record) throw new Error(`no record for ${winner.site}:${winner.site_id}`);
		const a = await admitRecord(db, record, opts);
		if (a.status !== 'existing' || a.printId !== printId) throw new Error(`${winner.site}:${winner.site_id} came out ${a.status}`);
		const r = await run(ingestRecord(record, a, opts));
		if (r.status !== 'analysed' && r.status !== 'unchanged') throw new Error(`ingest answered ${r.status}`);
	};
	const purge = (printId: string) => purgePrintData(takedownEnv, printId, { kind: 'gone' });
	for (const siteId of work.gone) {
		if (stopping || result.dryRun) break;
		try {
			const r = await sourceGone(db, site, siteId, {
				purge,
				reingest: (printId, winner) =>
					reingest(printId, winner).catch(async (e) => {
						say(`${site}/${siteId}: hand-over of ${printId} to ${winner.site}:${winner.site_id} failed, purged instead: ${reasonOf(e)}`);
						await purge(printId);
						await run(syncFold(printId));
						await markIngestDue(db);
					}),
				resync: (printId) => run(syncSources(printId)),
				refold: (printId) => run(syncFold(printId))
			});
			if (r.status === 'purged') result.gone.purged++;
			else if (r.status === 'handed-over') result.gone.handedOver++;
			else result.gone.kept++;
			if (r.status === 'purged' || r.status === 'handed-over') result.wrote = true;
			say(`${site}/${siteId}: gone from the site: ${r.status}${'printId' in r ? ` (${r.printId})` : ''}`);
			ledger.records[siteId] = 'gone';
		} catch (e) {
			result.gone.failed++;
			say(`${site}/${siteId}: ✗ gone from the site, but: ${reasonOf(e)}`);
		}
		await save();
	}
	await save(true);
	// The search sidebar's unfiltered counts, and the page cache (rebuildFacets bumps it).
	if (result.wrote)
		await run(
			Effect.gen(function* () {
				yield* (yield* PrintRepository).rebuildFacets();
			})
		);
	// The store holds the site's prints that are their own print on the stage, for the render step.
	if (result.wrote && !stopping) {
		result.store = await pullSite(storeDir, polledStoreAdapter(env, site), { stopping: () => stopping });
		const c = result.store;
		say(
			`record store: ${n(c.listed)} ${site} prints of their own, ${n(c.added)} new, ${n(c.changed)} changed, ${n(c.removed + c.vanished)} removed`
		);
	}

	const c = result.counts;
	const line =
		`${n(c.new)} new, ${n(c.joined)} joined an existing print, ${n(c.updated)} updated, ${n(c.unchanged + c.identified)} unchanged, ` +
		`${n(c.blocked)} blocked, ${n(c.undecodable)} unreadable, ${n(c.failed)} failed; ${n(result.suggestedNew)} of the new with suggestions` +
		(work.gone.length
			? `; gone: ${n(result.gone.purged)} purged, ${n(result.gone.kept + result.gone.handedOver)} kept (another source), ${n(result.gone.failed)} failed`
			: '') +
		(result.dryRun ? ' (dry run: nothing written)' : '');
	if (stopping) {
		code = 2;
		report(false, `✗ stopped: ${line}`);
	} else if (c.failed || result.gone.failed) {
		code = 2;
		report(false, `✗ ${line}`);
	} else report(true, `✓ ${line}`);
} catch (e) {
	code = 2;
	report(false, `✗ ${reasonOf(e)}`);
} finally {
	await target.dispose();
}
process.exit(code);
