/**
 * `bun run polled --stage local|prod --site codex|fprints [--dir DIR] [--dry-run] [--force] [--yes] [--json]`:
 * give the stage what a polled site's inbox holds (scripts/sync/polled.ts). Every record at a revision the
 * stage wasn't given goes through the one gate (`addRecord`, add-record.ts: admitRecord, then ingestRecord, in
 * Bun with no Worker caps; `update` for records the site changed, which detaches a copy edited into something
 * else), so blocks, joins (the same blueprint already here: first upload wins what is shown) and suggestions
 * apply as for any record. Every print the site deleted is a source gone, through the site's gate
 * (uploads/gate.ts `workerGate`, on the stage's real bindings: sync/gate-env.ts): it stays while another source
 * has it (credit handed over if it was this one), else it is purged as 'gone' with its renders, the edge
 * cache, and our copy of its screenshot when no other print shows it. A deployed stage needs R2_ACCESS_KEY_ID /
 * R2_SECRET_ACCESS_KEY, CACHE_PURGE_TOKEN and CACHE_ZONE_ID for that (gate-env.ts); without them the
 * deletions wait (the fetch already held back a mass deletion until it was accepted).
 *
 * The one-click update runs it in its ingest step, after the backfill, for each polled site that is on. When
 * it wrote, the record store's copy of the site is pulled from the stage (records/polled.ts), so the render
 * step that follows draws the new prints.
 *
 * What each stage was given: `<inbox>/<site>/.admitted.<stage>.json`; a record that fails (storage) is not
 * marked and is tried again next run. Refused records (blocked, unreadable) are marked: tried again only
 * when they change. A record whose inbox file is gone is forgotten, so the next fetch reads it again.
 * A record whose print a hand-over had to purge (another source went, and this one couldn't be ingested in
 * its place: identity-db.ts lostSources) goes through the gate again, whatever the ledger says.
 *
 *   --dir DIR        the record store (default RECORDS_DIR, else ~/data/factorio-records); the inbox is DIR/.polled
 *   --dry-run        D1 reads only: say what each record would be, write nothing
 *   --force          every inbox record again, whatever the stage was given
 *   --yes            don't ask before writing to prod
 *   --json           the result as JSON on stdout (`PolledAdmitResult`); every other line to stderr
 *
 * Refuses (but for --dry-run) while an update is live, unless that update started it: its ingest step runs this.
 *
 * Exit 0 when done (refusals and waiting deletions included), 2 on any error or when stopped (130 on the second
 * signal); the last line starts with ✓ or ✗.
 */
import { join, resolve } from 'node:path';
import { Effect, Layer } from 'effect';
import { printIdFor } from '#lib/print-id.js';
import { addRecord } from '#lib/server/pipeline/add-record.js';
import { lostSources } from '#lib/server/pipeline/identity-db.js';
import { OFFLINE_MAX_INFLATED_BYTES } from '#lib/server/pipeline/decode.js';
import { RawStoreR2 } from '#lib/server/pipeline/raw-store.js';
import { PrintRepository, PrintRepositoryD1 } from '#lib/server/pipeline/repository.js';
import { rawKeyFor } from '#lib/server/pipeline/source-record.js';
import { workerGate } from '#lib/server/uploads/gate.js';
import { POLLED_SITES } from '#lib/sync.js';
import { recordsDir, readStoreRecord } from './records/store';
import { polledStoreAdapter } from './records/polled';
import { pullSite, type PullCounts } from './records/pull';
import { confirmProd, jsonScript, n, parseStageArgs, requireSchema } from './stage-command';
import { openStageGate } from './sync/gate-env';
import { otherLiveUpdate } from './sync/local-db';
import { admissionWork, inboxDir, readLedger, readState, writeLedger, writeState } from './sync/polled';
import { progress } from './sync/progress';

const USAGE = 'usage: bun run polled --stage local|prod --site <site> [--dir DIR] [--dry-run] [--force] [--yes] [--json]';

export type AdmitOutcome =
	/** A print of its own. */
	| 'new'
	/** The same blueprint was here already (whole-print exact hash): this record joined that print. */
	| 'joined'
	/** Its own print, changed. */
	| 'updated'
	| 'unchanged'
	| 'blocked'
	| 'undecodable'
	/** Storage or the like: tried again next run. */
	| 'failed'
	/** Its inbox file was missing: forgotten, so the next fetch reads it again. */
	| 'refetch';

export interface PolledAdmitResult {
	ok: boolean;
	summary: string;
	stage: string | null;
	site: string;
	dryRun: boolean;
	stopped: boolean;
	/**
	 * It went through every record and deletion it had to the end (not stopped, no error outside a record): the
	 * records that failed then are retried next update (they aren't in the ledger), so the update goes on.
	 */
	finished: boolean;
	/** Records the stage wasn't given at their revision, and gone prints it still had, when it started. */
	waiting: number;
	goneWaiting: number;
	counts: Record<AdmitOutcome, number>;
	/**
	 * Gone prints: purged (no source left), kept (another source has them; credit handed over if it was this
	 * one), failed; waiting (the stage lacks what a purge needs); and purges whose edge purge failed.
	 */
	gone: { purged: number; kept: number; failed: number; waiting: number; edgeNotPurged: number };
	/** Of the new prints, those with suggestions: a near match for an admin to look at, never joined. */
	suggestedNew: number;
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
	finished: false,
	waiting: 0,
	goneWaiting: 0,
	counts: { new: 0, joined: 0, updated: 0, unchanged: 0, blocked: 0, undecodable: 0, failed: 0, refetch: 0 },
	gone: { purged: 0, kept: 0, failed: 0, waiting: 0, edgeNotPurged: 0 },
	suggestedNew: 0,
	wrote: false,
	store: null
};

const { say, report, onSignals, stopping } = jsonScript(result, {
	stoppedSummary: '✗ stopped before finishing',
	stopAfter: 'the current record'
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
// The update runs this itself (its ingest step) and writes the same ledger: a hand run waits for it to end.
const live = result.dryRun ? null : otherLiveUpdate(join(import.meta.dirname, '..'));
if (live) {
	console.error(`✗ an update is running (${live}): its ingest step admits the polled sites itself; run this once it has finished`);
	process.exit(2);
}
const storeDir = flags.dir ? resolve(flags.dir) : recordsDir();
const inbox = inboxDir(storeDir);

onSignals();
const target = await openStageGate(stage, generation).catch((e: unknown) => {
	console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
	process.exit(2);
});
onSignals();

const reasonOf = (e: unknown) => (e instanceof Error ? e.message || e.name : String(e)) || 'unknown error';
/**
 * A throw here is storage (a record's own problems are outcomes), and the local D1 is one SQLite file the
 * update's runner writes too, whose busy answers can come without a message: worth a few more tries.
 */
const TRIES = 4;
const NO_RECORD = 'no record in the inbox';

let code = 0;
try {
	const env = target.env;
	const db = env.DB;
	const gate = workerGate(env, { offline: true });
	await requireSchema(db, stage, 'SELECT site FROM print_sources LIMIT 0', 'print_sources table', '0022');
	const state = await readState(inbox, site);
	const ledger = await readLedger(inbox, site, stage);
	// Records whose print a failed hand-over purged (gate.ts sourceGone): through the gate again, whatever the ledger says.
	const lost = (await lostSources(db, site)).filter((id) => state.records[id]);
	const work = admissionWork(state, ledger, Boolean(flags.force), lost);
	result.waiting = work.records.length;
	result.goneWaiting = work.gone.length;
	progress({ t: 'admit', site, records: work.records.length });
	say(
		`${stage} ← ${site} inbox ${join(inbox, site)}: ${n(work.records.length)} records to admit` +
			(lost.length ? ` (${n(lost.length)} whose print a hand-over lost)` : '') +
			`, ${n(work.gone.length)} gone from the site`
	);
	if (!result.dryRun && (work.records.length || work.gone.length))
		await confirmProd(
			stage,
			Boolean(flags.yes),
			`Admit ${n(work.records.length)} ${site} records into prod, and delete or detach ${n(work.gone.length)} prints the site deleted?`
		);

	const layer = Layer.mergeAll(RawStoreR2(env.RAW), PrintRepositoryD1(db));
	const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) => Effect.runPromise(Effect.provide(effect, layer));
	let sinceSave = 0;
	const save = async (force = false) => {
		if (result.dryRun) return;
		if (force || ++sinceSave >= 25) {
			sinceSave = 0;
			await writeLedger(inbox, site, stage, ledger);
		}
	};

	/** One inbox record through the gate (addRecord: admitRecord, then ingestRecord); throws on storage errors. */
	const admitOne = async (printId: string): Promise<{ outcome: AdmitOutcome; note: string }> => {
		const record = await readStoreRecord(inbox, printId);
		if (!record) throw new Error(NO_RECORD);
		const r = await addRecord(env, record, { plan: result.dryRun, update: true, maxInflatedBytes: OFFLINE_MAX_INFLATED_BYTES });
		if (r.status === 'failed') throw new Error(r.reason);
		if (r.status === 'new' && r.suggestions.length) result.suggestedNew++;
		switch (r.status) {
			case 'new':
				return { outcome: 'new', note: '' };
			case 'joins':
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
		if (stopping()) break;
		const rev = state.records[siteId].rev;
		const printId = printIdFor(site, siteId);
		let outcome: AdmitOutcome = 'failed';
		let note = '';
		for (let attempt = 1; attempt <= TRIES; attempt++) {
			try {
				({ outcome, note } = await admitOne(printId));
				ledger.records[siteId] = rev;
				break;
			} catch (e) {
				outcome = 'failed';
				note = reasonOf(e);
				if (note === NO_RECORD) {
					// The inbox lost its file: forget the record, so the next fetch reads it again (never a stuck update).
					if (!result.dryRun) {
						delete state.records[siteId];
						await writeState(inbox, site, state);
					}
					outcome = 'refetch';
					break;
				}
				if (attempt === TRIES) break;
				await new Promise((r) => setTimeout(r, 500 * attempt + Math.random() * 500));
			}
		}
		result.counts[outcome]++;
		if (!result.dryRun && (outcome === 'new' || outcome === 'joined' || outcome === 'updated')) result.wrote = true;
		say(`${site}/${siteId}: ${outcome}${note ? ` (${note})` : ''}`);
		progress({ t: 'record', site, outcome });
		await save();
	}

	// The site deleted these: a source gone, through the site's gate (src/lib/server/uploads/gate.ts, without the
	// Worker's caps): kept while another source has the print (credit handed over if it was this one), else purged
	// as 'gone', with our copy of its screenshot when no other print shows it, its renders and the edge cache
	// (gate-env.ts: the stage's real buckets and purge token). The fetch already held back a mass deletion until
	// accepted; one that can't purge everything waits.
	if (work.gone.length && !result.dryRun && !target.canPurge) {
		result.gone.waiting = work.gone.length;
		say(`! ${n(work.gone.length)} ${site} prints gone, but purging ${stage} needs ${target.missing.join(', ')}: left for the next run`);
	} else
		for (const siteId of work.gone) {
			if (stopping() || result.dryRun) break;
			const key = rawKeyFor(site, siteId);
			try {
				const r = await gate.sourceGone(
					siteId,
					{
						extra: () => [],
						extraKeys: [key],
						onPurged: (p) => {
							if (p.purgeError) {
								result.gone.edgeNotPurged++;
								say(
									`! ${site}/${siteId}: the edge cache wasn't purged (${p.purgeError}): ${[...p.purge.prefixes, ...p.purge.urls].join(' ')}`
								);
							}
						}
					},
					site
				);
				if (r === 'purged') result.gone.purged++;
				else result.gone.kept++;
				// Its archive goes too, unless it is still the record a print shows.
				if (r !== 'purged' && !(await db.prepare('SELECT 1 AS hit FROM prints WHERE raw_key = ?').bind(key).first()))
					await env.RAW.delete(key);
				if (r !== 'none') result.wrote = true;
				say(`${site}/${siteId}: gone from the site: ${r}`);
				progress({ t: 'record', site, outcome: 'gone' });
				ledger.records[siteId] = 'gone';
			} catch (e) {
				result.gone.failed++;
				say(`${site}/${siteId}: ✗ gone from the site, but: ${reasonOf(e)}`);
				progress({ t: 'record', site, outcome: 'failed' });
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
	if (result.wrote && !stopping()) {
		result.store = await pullSite(storeDir, polledStoreAdapter(env, site), { stopping });
		const c = result.store;
		say(
			`record store: ${n(c.listed)} ${site} prints of their own, ${n(c.added)} new, ${n(c.changed)} changed, ${n(c.removed + c.vanished)} removed`
		);
	}

	const c = result.counts;
	const line =
		`${n(c.new)} new, ${n(c.joined)} joined an existing print, ${n(c.updated)} updated, ${n(c.unchanged)} unchanged, ` +
		`${n(c.blocked)} blocked, ${n(c.undecodable)} unreadable, ${n(c.failed)} failed; ${n(result.suggestedNew)} of the new with suggestions` +
		(work.gone.length
			? `; gone: ${n(result.gone.purged)} purged, ${n(result.gone.kept)} kept (another source), ${n(result.gone.failed)} failed` +
				(result.gone.waiting ? `, ${n(result.gone.waiting)} waiting (${target.missing.join(', ')})` : '') +
				(result.gone.edgeNotPurged ? `, ${n(result.gone.edgeNotPurged)} not purged from the edge cache` : '')
			: '') +
		(result.dryRun
			? `${work.gone.length ? `; ${n(work.gone.length)} gone from the site to delete or detach` : ''} (dry run: nothing written)`
			: '');
	if (stopping()) {
		code = 2;
		report(false, `✗ stopped: ${line}`);
	} else if (c.failed || result.gone.failed) {
		result.finished = true;
		code = 2;
		report(false, `✗ ${line}`);
	} else {
		result.finished = true;
		report(true, `✓ ${line}`);
	}
} catch (e) {
	code = 2;
	report(false, `✗ ${reasonOf(e)}`);
} finally {
	await target.dispose();
}
process.exit(code);
