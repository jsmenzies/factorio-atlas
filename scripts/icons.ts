/**
 * Game icons for the site, from the game's own icon dump, as one WebP per icon.
 *
 *   factorio --dump-icon-sprites        # writes <user data>/script-output/<type>/<name>.png
 *   bun run icons <script-output dir> [--game-version 2.0.77] [--no-upload]
 *   bun run icons --upload local|remote # upload the set in data/game/icons.json again
 *
 * Building encodes every icon of the types in ICON_TYPES (#lib/icons.js) with `cwebp` (libwebp,
 * must be on PATH) at 64 px, into data/sprites/icons/<set>/<type>/<name>.webp, where <set> is
 * `<game version>-<content hash>`, so a new set gets new URLs and every file can be cached as
 * immutable. It writes data/game/icons.json (the set and which names it has; the server resolves
 * icons from it, so missing ones are blank without a request) and uploads the set to the local
 * SPRITES bucket that `bun run dev` uses. The game version is read from factorio-current.log next
 * to the dump folder unless given.
 *
 * `--upload remote` uploads the set named in data/game/icons.json from data/sprites to the one
 * deployed sprites bucket that every stage links to (created by `bun run deploy:prod`), with
 * `wrangler r2 bulk put --remote` (experimental in wrangler 4, with your `wrangler login`; about
 * 1,100 objects per 5 minutes). Upload before deploying a Worker that uses a new set.
 *
 * Icons are Wube's art: data/sprites is gitignored and must stay that way.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { ICON_TYPES } from '#lib/icons.js';
import type { IconManifest } from '#lib/server/icon-set.js';
import { SPRITES_BUCKET } from '../infra/databases';
import { accountId, checkBucket } from './backfill/stage';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'data', 'sprites');
const MANIFEST = join(ROOT, 'data', 'game', 'icons.json');
const SIZE = 64;
/** Measured on 2.0 icons: about 2.5 KB each, with lossless alpha so edges stay clean. */
const CWEBP_ARGS = ['-quiet', '-q', '90', '-alpha_q', '100', '-m', '6'];
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** Names that are safe as URL path segments and R2 keys as they are (all of vanilla and Space Age). */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const usage = 'usage: bun run icons <script-output dir> [--game-version <x.y.z>] [--no-upload] | bun run icons --upload local|remote';
const fail = (message: string): never => {
	console.error(message);
	process.exit(1);
};

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
	console.log(usage);
	process.exit(0);
}
const flag = (name: string) => {
	const i = argv.indexOf(name);
	if (i < 0) return false;
	argv.splice(i, 1);
	return true;
};
const option = (name: string) => {
	const i = argv.indexOf(name);
	if (i < 0) return undefined;
	const [, value] = argv.splice(i, 2);
	if (value === undefined || value.startsWith('--')) fail(`${name} needs a value\n${usage}`);
	return value;
};
const target = option('--upload');
const gameVersionArg = option('--game-version');
const upload = !flag('--no-upload');
const stray = argv.find((a) => a.startsWith('--'));
if (stray) fail(`unknown argument: ${stray}\n${usage}`);

const readManifest = async () => JSON.parse(await readFile(MANIFEST, 'utf8')) as IconManifest;
const keysOf = (m: IconManifest) =>
	ICON_TYPES.flatMap((type) => (m.types[type] ?? []).map((name) => `icons/${m.set}/${type}/${name}.webp`));

/** Width and height from a PNG's IHDR chunk. */
const pngSize = async (path: string): Promise<[number, number]> => {
	const file = await open(path);
	try {
		const head = Buffer.alloc(24);
		await file.read(head, 0, 24, 0);
		return [head.readUInt32BE(16), head.readUInt32BE(20)];
	} finally {
		await file.close();
	}
};

const cwebp = (args: string[]) =>
	new Promise<void>((done, fail) => {
		const child = spawn('cwebp', args, { stdio: ['ignore', 'ignore', 'pipe'] });
		let err = '';
		child.stderr.on('data', (d) => (err += d));
		child.once('error', (e) => fail(new Error(`couldn't run cwebp (${e.message}); install libwebp so cwebp is on PATH`)));
		child.once('exit', (code) => (code === 0 ? done() : fail(new Error(`cwebp ${args.at(-3)} failed (${code}): ${err.trim()}`))));
	});

const pool = async <T>(items: T[], size: number, work: (item: T) => Promise<void>) => {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(size, items.length) }, async () => {
			while (next < items.length) await work(items[next++]);
		})
	);
};

const detectVersion = async (dumpDir: string) => {
	if (gameVersionArg) return gameVersionArg;
	const log = await readFile(join(dumpDir, '..', 'factorio-current.log'), 'utf8').catch(() => '');
	const found = /Factorio (\d+\.\d+\.\d+)/.exec(log.slice(0, 2000))?.[1];
	if (!found) throw new Error(`couldn't read the game version from ${join(dumpDir, '..', 'factorio-current.log')}; pass --game-version`);
	return found;
};

async function build(dumpDir: string): Promise<IconManifest> {
	const gameVersion = await detectVersion(dumpDir);
	const jobs: { type: string; name: string; src: string }[] = [];
	const skipped: string[] = [];
	for (const type of ICON_TYPES) {
		const files = await readdir(join(dumpDir, type)).catch(() => null);
		if (!files) {
			console.warn(`  no ${type}/ folder in ${dumpDir}`);
			continue;
		}
		for (const f of files.filter((f) => f.endsWith('.png')).sort()) {
			const name = f.slice(0, -4);
			if (SAFE_NAME.test(name)) jobs.push({ type, name, src: join(dumpDir, type, f) });
			else skipped.push(`${type}/${name}`);
		}
	}
	if (!jobs.length) throw new Error(`no icons in ${dumpDir}: run the game with --dump-icon-sprites first`);
	if (skipped.length) console.warn(`  skipped ${skipped.length} names that aren't URL-safe: ${skipped.slice(0, 10).join(', ')}`);

	const tmp = join(OUT, 'icons', `.tmp-${process.pid}`);
	await rm(tmp, { recursive: true, force: true });
	for (const type of new Set(jobs.map((j) => j.type))) await mkdir(join(tmp, type), { recursive: true });
	let done = 0;
	await pool(jobs, cpus().length, async (j) => {
		const [w, h] = await pngSize(j.src);
		const resize = w === SIZE && h === SIZE ? [] : ['-resize', String(SIZE), String(SIZE)];
		await cwebp([...CWEBP_ARGS, ...resize, j.src, '-o', join(tmp, j.type, `${j.name}.webp`)]);
		if (++done % 500 === 0) console.log(`  ${done}/${jobs.length}`);
	});

	// The set's name hashes every key and file, so any change gives new URLs.
	const hash = createHash('sha256');
	let bytes = 0;
	for (const j of jobs) {
		const body = await readFile(join(tmp, j.type, `${j.name}.webp`));
		bytes += body.byteLength;
		hash.update(`${j.type}/${j.name}\0`).update(body);
	}
	const set = `${gameVersion}-${hash.digest('hex').slice(0, 10)}`;
	const dest = join(OUT, 'icons', set);
	await rm(dest, { recursive: true, force: true });
	await rename(tmp, dest);

	const types: IconManifest['types'] = {};
	for (const j of jobs) (types[j.type as keyof typeof types] ??= []).push(j.name);
	const manifest: IconManifest = { gameVersion, set, size: SIZE, types };
	await writeFile(MANIFEST, JSON.stringify(manifest) + '\n');
	console.log(`wrote ${jobs.length} icons (${(bytes / 1e6).toFixed(1)} MB) to data/sprites/icons/${set}, and data/game/icons.json`);
	return manifest;
}

/** The local bucket `bun run dev` reads, through the same miniflare state. */
async function uploadLocal(m: IconManifest) {
	const proxy = await getPlatformProxy<Env>({ persist: true, remoteBindings: false, envFiles: [] });
	try {
		const keys = keysOf(m);
		await pool(keys, 16, async (key) => {
			await proxy.env.SPRITES.put(key, await readFile(join(OUT, key)), {
				httpMetadata: { contentType: 'image/webp', cacheControl: CACHE_CONTROL }
			});
		});
		console.log(
			`uploaded ${keys.length} icons to the local SPRITES bucket (restart \`bun run dev\` if it was running before SPRITES existed)`
		);
	} finally {
		await proxy.dispose();
	}
}

/** The deployed sprites bucket (prod owns it), with wrangler's bulk upload (the REST API, rate-limited). */
async function uploadRemote(m: IconManifest) {
	const bucket = SPRITES_BUCKET;
	checkBucket('prod', bucket);
	const list = join(ROOT, '.wrangler', 'sprites', `${m.set}.json`);
	await mkdir(dirname(list), { recursive: true });
	await writeFile(list, JSON.stringify(keysOf(m).map((key) => ({ key, file: join(OUT, key) }))));
	console.log(`uploading ${keysOf(m).length} icons to ${bucket}`);
	const r = spawnSync(
		join(ROOT, 'node_modules', '.bin', 'wrangler'),
		[
			'r2',
			'bulk',
			'put',
			bucket,
			'--remote',
			'--force',
			'--filename',
			list,
			'--content-type',
			'image/webp',
			'--cache-control',
			CACHE_CONTROL
		],
		{ cwd: ROOT, stdio: 'inherit', env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId(), WRANGLER_SEND_METRICS: 'false' } }
	);
	if (r.status !== 0) throw new Error(`wrangler r2 bulk put failed (${r.status})`);
}

try {
	if (target) {
		if (argv.length || !['local', 'remote'].includes(target)) throw new Error(usage);
		const m = await readManifest();
		const missing = (await readdir(join(OUT, 'icons', m.set)).catch(() => null)) === null;
		if (missing) throw new Error(`data/sprites/icons/${m.set} isn't on this machine: build it with \`bun run icons <script-output dir>\``);
		if (target === 'local') await uploadLocal(m);
		else await uploadRemote(m);
	} else {
		const dir = argv[0];
		if (!dir || argv.length > 1) throw new Error(usage);
		const m = await build(resolve(dir));
		if (upload) await uploadLocal(m);
	}
} catch (e) {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
}
