/**
 * `bun run authors --stage local|prod`: put author names on prints whose record has only the
 * author's user id (most of them), in that stage's `authors` table (migration 0017), card rows,
 * search rows (so typed text finds an author) and R2 documents (the print page).
 *
 * 1. Authors named by one of their prints' own records get that name, for all their prints.
 * 2. The rest are looked up once each in Firebase's public `users/<id>/displayName`, one at a time
 *    at `--rate` per second (default 5): its bandwidth is billed to factorioprints' maintainer, so
 *    never more. Answers, names or none, are kept in the stage's `authors` table and in
 *    .cache/authors/firebase.json (gitignored), so no author is ever asked twice, from any stage.
 * 3. Every print with no name whose author has one gets it.
 *
 * Idempotent and resumable: Ctrl-C stops the lookups after the current one and still saves and
 * applies what came back; the next run carries on. New prints get their names at ingest.
 *
 *   --stage S     local = the miniflare state `bun run dev` uses; prod = the deployed stage
 *   --db N        D1 generation for prod (default: DATABASES.<stage>.bound in infra/databases.ts)
 *   --limit N     ask Firebase about at most N authors this run
 *   --rate R      Firebase lookups per second, at most 10 (default 5)
 *   --dry-run     show what would happen; no lookups, nothing written
 *   --yes         don't ask before writing to prod
 *
 * Prod is reached through the backfill's remote bindings (scripts/backfill/stage.ts), so it needs
 * `wrangler login` and Node on PATH, and the stage must be deployed with migration 0017.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import {
	applyNameFixes,
	authorRowStatements,
	fetchDisplayName,
	loadAuthorState,
	planNameFixes,
	recordNames,
	unknownAuthors
} from '#lib/server/pipeline/authors.js';
import { openTarget, STAGES, TargetError, type Stage } from './backfill/stage';
import { Terminal } from './backfill/terminal';

const USAGE = 'usage: bun run authors --stage local|prod [--db N] [--limit N] [--rate R] [--dry-run] [--yes]';
const CACHE = join(import.meta.dirname, '..', '.cache', 'authors', 'firebase.json');

const fail = (message: string): never => {
	console.error(message);
	process.exit(2);
};

const { values: flags } = (() => {
	try {
		return parseArgs({
			options: {
				stage: { type: 'string' },
				db: { type: 'string' },
				limit: { type: 'string' },
				rate: { type: 'string', default: '5' },
				'dry-run': { type: 'boolean', default: false },
				yes: { type: 'boolean', default: false },
				help: { type: 'boolean', short: 'h', default: false }
			},
			strict: true
		});
	} catch (e) {
		return fail(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
	}
})();
if (flags.help) {
	console.log(USAGE);
	process.exit(0);
}
const stage = flags.stage as Stage;
if (!STAGES.includes(stage)) fail(`--stage ${STAGES.join('|')} is required\n${USAGE}`);
const generation = flags.db === undefined ? undefined : Number(flags.db);
if (generation !== undefined && !(Number.isInteger(generation) && generation > 0)) fail('--db must be a positive integer');
const limit = flags.limit === undefined ? Infinity : Number(flags.limit);
if (!(limit === Infinity || (Number.isInteger(limit) && limit >= 0))) fail('--limit must be a whole number');
const rate = Number(flags.rate);
if (!(rate > 0 && rate <= 10)) fail('--rate must be more than 0 and at most 10');
const n = (x: number) => x.toLocaleString('en-US');

/** Firebase's answers from earlier runs, on any stage: author id → name (null: none). */
const readCache = (): Map<string, string | null> => {
	try {
		return new Map(Object.entries(JSON.parse(readFileSync(CACHE, 'utf8')) as Record<string, string | null>));
	} catch {
		return new Map();
	}
};
const writeCache = (cache: Map<string, string | null>) => {
	mkdirSync(dirname(CACHE), { recursive: true });
	writeFileSync(`${CACHE}.tmp`, JSON.stringify(Object.fromEntries(cache)));
	renameSync(`${CACHE}.tmp`, CACHE);
};

const target = await openTarget(stage, { generation }).catch((e: unknown) =>
	fail(e instanceof TargetError || e instanceof Error ? `✗ ${e.message}` : String(e))
);
const db = target.env.DB;
try {
	await db
		.prepare('SELECT author_id FROM authors LIMIT 0')
		.all()
		.catch(() => {
			throw new TargetError(
				stage === 'local'
					? 'the local D1 database has no authors table: run `bun run db:migrate`'
					: `the ${stage} D1 database has no authors table: deploy applies migration 0017`
			);
		});
	const state = await loadAuthorState(db);
	const cache = readCache();
	const seeded = recordNames(state);
	const unknown = unknownAuthors(state);
	const cached = unknown.filter((id) => cache.has(id));
	const toAsk = unknown.filter((id) => !cache.has(id)).slice(0, limit === Infinity ? undefined : limit);
	const authorCount = new Set(state.prints.map((p) => p.author_id)).size;
	const unnamed = state.prints.filter((p) => !p.author_name).length;
	console.log(
		`${target.database}: ${n(state.prints.length)} prints by ${n(authorCount)} authors, ${n(unnamed)} without a name; ` +
			`${n(state.authors.size)} authors known`
	);
	console.log(
		`  ${n(seeded.length)} named by their own records, ${n(cached.length)} answered by Firebase before (cache), ` +
			`${n(unknown.length - cached.length)} to ask Firebase` +
			(toAsk.length < unknown.length - cached.length ? ` (${n(toAsk.length)} this run, --limit)` : '') +
			(toAsk.length ? `: about ${Math.ceil(toAsk.length / rate / 60)} min at ${rate}/s` : '')
	);
	if (flags['dry-run']) {
		for (const [id, name] of seeded) state.authors.set(id, name);
		for (const id of cached) state.authors.set(id, cache.get(id) ?? null);
		console.log(`  ${n(planNameFixes(state).length)} prints would get a name before any lookup; dry run, nothing written`);
	} else {
		if (stage === 'prod' && !flags.yes) {
			const term = new Terminal();
			if (!term.tty) throw new TargetError('refusing to write to prod without a terminal to confirm in: pass --yes');
			if ((await term.ask('Write names to PROD? Type "prod" to continue: ')) !== 'prod')
				throw new TargetError('not confirmed; nothing written');
		}
		const known: [string, string | null][] = cached.map((id) => [id, cache.get(id) ?? null]);
		const first = [...authorRowStatements(db, seeded, 'record'), ...authorRowStatements(db, known, 'firebase')];
		for (let i = 0; i < first.length; i += 50) await db.batch(first.slice(i, i + 50));
		for (const [id, name] of [...seeded, ...known]) state.authors.set(id, name);

		// One lookup at a time, no faster than `rate`; answers are saved every 50 and at the end.
		let stop = false;
		process.once('SIGINT', () => {
			stop = true;
			console.log('\n  stopping after this lookup…');
		});
		const pending: [string, string | null][] = [];
		const save = async () => {
			if (pending.length === 0) return;
			writeCache(cache);
			await db.batch(authorRowStatements(db, pending.splice(0), 'firebase'));
		};
		let asked = 0;
		let named = 0;
		let failure: string | null = null;
		for (const id of toAsk) {
			if (stop) break;
			const started = Date.now();
			let name: string | null | undefined;
			for (let attempt = 1; name === undefined; attempt++) {
				try {
					name = await fetchDisplayName(id);
				} catch (e) {
					if (attempt === 3) {
						failure = e instanceof Error ? e.message : String(e);
						break;
					}
					await sleep(attempt * 5000);
				}
			}
			// Three failures in a row: stop asking (Firebase may be refusing), keep what came back.
			if (name === undefined) break;
			cache.set(id, name);
			state.authors.set(id, name);
			pending.push([id, name]);
			asked++;
			if (name) named++;
			if (pending.length >= 50) await save();
			process.stdout.write(`\r  asked ${n(asked)}/${n(toAsk.length)}, ${n(named)} named`);
			await sleep(Math.max(0, 1000 / rate - (Date.now() - started)));
		}
		await save();
		if (asked) process.stdout.write('\n');
		if (failure) console.log(`  ✗ lookups stopped: ${failure}`);

		const fixes = planNameFixes(state);
		console.log(`  ${n(fixes.length)} prints to name`);
		const done = await applyNameFixes(db, target.env.RAW, fixes, {
			onChunk: (i, docs) => process.stdout.write(`\r  ${n(i)}/${n(fixes.length)} prints, ${n(docs)} documents rewritten`)
		});
		if (fixes.length) process.stdout.write('\n');
		const left = unknownAuthors(state).length;
		console.log(
			`✓ ${n(done.docsWritten)} documents and ${n(done.rowsWritten)} D1 rows written` +
				(left ? `; ${n(left)} authors still to ask (run again)` : '; every author has been asked')
		);
	}
} catch (e) {
	await target.dispose();
	fail(`✗ ${e instanceof Error ? e.message : String(e)}`);
}
await target.dispose();
process.exit(0);
