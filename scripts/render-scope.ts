/**
 * What the render runs cover, refreshed without rendering anything; /admin/render shows the results.
 *
 *   bun run render:top <N> --from-clone <mirror clone> | --from-disk [dir]   [--json]
 *       Rank every print in the source by `numberOfFavorites` and store the top N in render_favorites
 *       (migration 0014). Prints that drop out keep their row with in_top = 0, so their renders stay.
 *       `bun run render --top N` uses the stored list (and refreshes it itself when it is missing or
 *       shorter than N).
 *   bun run render:check --from-clone <mirror clone> | --from-disk [dir]   [--json]
 *       Compare every print a run has looked at (render_prints, its file's size:mtime then) with its
 *       record file now, and store those that changed or are gone in render_source_changes. A batch
 *       (`--next`) looks at a changed print again and draws only the pages whose input changed.
 *
 * Reads only the record files' favourites counts and stamps; writes the local D1 (the same state
 * `vite dev` uses, through wrangler's platform proxy). `--json` prints the result as one JSON line.
 */
import { join, resolve } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { checkSources, favoritesCacheFile, favoritesDb, refreshFavorites } from './render/favorites.js';
import { ROOT } from './render/settings.js';
import { cloneSource, diskSource } from './render/source.js';

const USAGE =
	'usage: render-scope top <N> --from-clone <dir> | --from-disk [dir] [--json]\n' +
	'       render-scope check --from-clone <dir> | --from-disk [dir] [--json]';

function fail(problem: string): never {
	console.error(`${problem}\n${USAGE}`);
	process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
	console.log(USAGE);
	process.exit(0);
}
const command = argv.shift();
if (command !== 'top' && command !== 'check') fail(`unknown command: ${command ?? '(none)'}`);
let n: number | null = null;
if (command === 'top') {
	n = Number(argv.shift());
	if (!Number.isInteger(n) || n < 1 || n > 100_000) fail('top needs a whole number from 1 to 100000');
}
let clone: string | null = null;
let disk: string | null = null;
let asJson = false;
while (argv.length) {
	const a = argv.shift()!;
	if (a === '--from-clone') clone = argv[0] && !argv[0].startsWith('--') ? argv.shift()! : fail('--from-clone needs a folder');
	else if (a === '--from-disk') disk = argv[0] && !argv[0].startsWith('--') ? argv.shift()! : join(ROOT, 'data', 'raw', 'factorioprints');
	else if (a === '--json') asJson = true;
	else fail(`unknown argument: ${a}`);
}
if (!clone === !disk) fail('pick one source: --from-clone <dir> or --from-disk [dir]');
const dir = resolve((clone ?? disk)!);
const source = clone ? cloneSource(dir) : diskSource(dir);

const proxy = await getPlatformProxy<Env>({ persist: true });
let code = 0;
try {
	const fdb = favoritesDb(proxy.env.DB);
	if (command === 'top') {
		const meta = await refreshFavorites(fdb, source, n!, favoritesCacheFile(join(ROOT, '.cache', 'render'), dir));
		const rows = await fdb.rows();
		const former = rows.filter((r) => !r.in_top).length;
		if (asJson) console.log(JSON.stringify({ ...meta, former }));
		else
			console.log(
				`top ${meta.n} of ${meta.prints} prints in ${meta.source}: at least ${meta.cutoff} favourites; ${meta.parsed} records read, ` +
					`${meta.ms} ms${former ? `; ${former} earlier favourites kept outside the top ${meta.n}` : ''}`
			);
	} else {
		const meta = await checkSources(fdb, source);
		if (asJson) console.log(JSON.stringify(meta));
		else
			console.log(
				`${meta.compared} prints compared with ${meta.source} in ${meta.ms} ms: ${meta.changed} changed since a run looked at them, ` +
					`${meta.gone} gone, ${meta.unseen} never looked at`
			);
	}
} catch (e) {
	console.error(e instanceof Error ? e.message : String(e));
	code = 1;
} finally {
	await proxy.dispose();
}
process.exit(code);
