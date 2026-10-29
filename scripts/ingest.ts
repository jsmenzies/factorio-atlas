/**
 * Local ingestion CLI. Runs the same Effect pipeline as the Worker, bound to the
 * local miniflare D1/R2 state that `vite dev` also uses (.wrangler/state).
 *
 *   bun run ingest --top 1          # most-favourited print(s)
 *   bun run ingest <id> [<id> ...]  # specific prints
 *   bun run ingest --reanalyze <id> # re-run analysis from the raw store
 *   bun run ingest --from-disk [dir] # re-ingest every record saved in data/raw, no network
 *
 * Re-runs skip records that haven't changed (see `ingest_state`); a favourites-only change is
 * one small update. Flags: --force re-analyses everything, --retry-failed retries records
 * that failed before (corrupt strings, the 0.14 format) even though they haven't changed.
 *
 * Raw records are also copied to data/raw/ (gitignored: prints belong to their authors and are never
 * committed), for poking at by hand, for `--from-disk` and for `bun run render`.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Effect, Layer } from 'effect';
import { getPlatformProxy } from 'wrangler';
import { isPrintId } from '#lib/print-id.js';
import { pipelineLayer } from '#lib/server/pipeline/layers.js';
import { OFFLINE_MAX_INFLATED_BYTES } from '#lib/server/pipeline/decode.js';
import { ingestPrint, ingestText, reanalyzePrint, type IngestOptions, type IngestOutcome } from '#lib/server/pipeline/pipeline.js';
import { RawStore } from '#lib/server/pipeline/raw-store.js';
import { PrintRepository } from '#lib/server/pipeline/repository.js';
import { StorageError } from '#lib/server/pipeline/errors.js';
import { mirrorPath, PrintSource } from '#lib/server/pipeline/source.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data', 'raw');

/** Wrap the R2 store so every raw record put is mirrored to data/raw/ (analysis docs stay in R2). */
const withLocalCopy = Layer.effect(
	RawStore,
	Effect.gen(function* () {
		const r2 = yield* RawStore;
		return {
			get: r2.get,
			delete: r2.delete,
			put: (key: string, body: string, contentType?: string) =>
				Effect.gen(function* () {
					yield* r2.put(key, body, contentType);
					if (!key.startsWith('factorioprints/')) return;
					const path = join(DATA_DIR, key);
					yield* Effect.tryPromise({
						try: async () => {
							await mkdir(dirname(path), { recursive: true });
							await writeFile(path, JSON.stringify(JSON.parse(body), null, 2));
						},
						catch: (cause) => new StorageError({ op: `fs.write ${path}`, cause })
					});
				})
		};
	})
);

const USAGE = 'usage: bun run ingest <id>... | --top N | --reanalyze <id>... | --from-disk [dir]   [--force] [--retry-failed]';
const usage = (problem?: string): never => {
	if (problem) console.error(problem);
	console.error(USAGE);
	process.exit(1);
};

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
	console.log(USAGE);
	process.exit(0);
}
const options: IngestOptions = {
	force: argv.includes('--force'),
	retryFailed: argv.includes('--retry-failed'),
	maxInflatedBytes: OFFLINE_MAX_INFLATED_BYTES
};
const args = argv.filter((a) => a !== '--force' && a !== '--retry-failed');
// Checked before the platform proxy starts: a mode flag comes first, and nothing else may look like one.
const mode = ['--top', '--reanalyze', '--from-disk'].includes(args[0]) ? args[0] : null;
const rest = mode ? args.slice(1) : args;
const stray = rest.find((a) => a.startsWith('--') && !isPrintId(a));
if (stray) usage(`unknown argument: ${stray}`);
if (!mode && !rest.length) usage();
if (mode === '--reanalyze' && !rest.length) usage('--reanalyze needs at least one id');
if ((mode === '--top' || mode === '--from-disk') && rest.length > 1) usage(`${mode} takes one value`);
if (mode === '--top' && !(Number.isInteger(Number(rest[0] ?? 1)) && Number(rest[0] ?? 1) >= 1)) usage('--top needs a whole number');

const counts: Record<IngestOutcome['status'], number> = {
	analysed: 0,
	failed: 0,
	'skipped-failed': 0,
	unchanged: 0,
	removed: 0,
	identified: 0,
	blocked: 0,
	favorites: 0,
	viewer: 0,
	reindexed: 0
};
let rowsWritten = 0;
let viewerFiles = 0;
/** Sidebar counts are rebuilt once at the end, and only if something was written. */
const finish = Effect.gen(function* () {
	if (counts.analysed + counts.failed + counts.favorites + counts.reindexed > 0) yield* (yield* PrintRepository).rebuildFacets();
	const perPrint = counts.analysed ? (rowsWritten / counts.analysed).toFixed(1) : '0';
	yield* Effect.logInfo(
		`done: ${JSON.stringify(counts)}; D1 rows written by analysed prints: ${rowsWritten} (${perPrint} per print); ` +
			`R2 viewer objects written: ${viewerFiles}`
	);
});
const report = (o: IngestOutcome) =>
	Effect.gen(function* () {
		counts[o.status]++;
		if (o.status === 'analysed') {
			rowsWritten += o.rowsWritten;
			viewerFiles += o.viewerFiles;
			const a = o.analysis;
			yield* Effect.logInfo(
				`stored ${o.id} "${o.title}": ${a.rootKind}, v${a.gameVersion}, ${a.blueprintCount} blueprints, ` +
					`${a.entityCount} entities, ${Object.keys(a.recipes).length} recipes, space age=${a.requiresSpaceAge}`
			);
		} else if (o.status === 'failed') yield* Effect.logWarning(`failed ${o.id}: ${o.reason} (tracked; skipped until it changes)`);
		else if (o.status === 'favorites') yield* Effect.logInfo(`favourites only ${o.id}: ${o.favorites}`);
		else if (o.status === 'removed') yield* Effect.logWarning(`removed ${o.id}: blocked by an approved removal, nothing stored`);
		else if (o.status === 'identified') yield* Effect.logInfo(`identity rows only ${o.id}`);
		else if (o.status === 'blocked')
			yield* Effect.logWarning(`blocked ${o.id}: the same blueprint as removed print ${o.by}, nothing stored`);
		else if (o.status === 'viewer') {
			viewerFiles += o.viewerFiles;
			yield* Effect.logInfo(`viewer files only ${o.id}: ${o.viewerFiles} objects`);
		} else if (o.status === 'reindexed') {
			viewerFiles += o.viewerFiles;
			yield* Effect.logInfo(`re-indexed ${o.id}: ${o.rowsWritten} D1 rows`);
		}
	});
const proxy = await getPlatformProxy<Env>({ persist: true });

const base = pipelineLayer(proxy.env);
const layer = Layer.merge(base, withLocalCopy.pipe(Layer.provide(base)));

const program = Effect.gen(function* () {
	let ids: string[];
	let reanalyze = false;
	if (args[0] === '--from-disk') {
		const dir = args[1] ?? join(DATA_DIR, 'factorioprints');
		const files = (yield* Effect.promise(() => readdir(dir))).filter((f) => f.endsWith('.json'));
		for (const f of files) {
			const id = f.slice(0, -'.json'.length);
			const text = yield* Effect.promise(() => readFile(join(dir, f), 'utf8'));
			const url = `${proxy.env.MIRROR_BASE_URL}/${mirrorPath(id)}`;
			const result = yield* ingestText(id, text, url, options).pipe(
				Effect.catch((e) => Effect.logError(`error ${id}: ${e._tag}`, e).pipe(Effect.as(null)))
			);
			if (result) yield* report(result);
		}
		return yield* finish;
	}
	if (args[0] === '--top') {
		const n = Number(args[1] ?? 1);
		const top = yield* (yield* PrintSource).topByFavorites(n);
		for (const s of top) yield* Effect.logInfo(`top: ${s.numberOfFavorites}★ ${s.id} ${s.title}`);
		ids = top.map((s) => s.id);
	} else if (args[0] === '--reanalyze') {
		reanalyze = true;
		ids = args.slice(1);
	} else {
		ids = args;
	}
	for (const id of ids) {
		const result = yield* (reanalyze ? reanalyzePrint(id, options) : ingestPrint(id, options)).pipe(
			Effect.catch((e) => Effect.logError(`error ${id}: ${e._tag}`, e).pipe(Effect.as(null)))
		);
		if (result) yield* report(result);
	}
	yield* finish;
});

try {
	await Effect.runPromise(program.pipe(Effect.provide(layer)));
} finally {
	await proxy.dispose();
}
