/**
 * `bun run add <link> --stage local|prod [--plan] [--yes] [--json] [--dir DIR]`: add one print from
 * another site by its link (today factoriobin: https://factoriobin.com/post/<id>), as /admin/add does in
 * the Worker, but without the Worker's size caps. The post is read once (src/lib/server/pipeline/
 * factoriobin.ts; the two responses cached an hour in .cache/factoriobin/http/, so a look-up and then an
 * add read it once) and goes through the one gate (add-record.ts: admitRecord, then ingestRecord): new
 * as `fbin-<id>`, joined to the print it is an exact copy of, already here, or refused (blocked,
 * unreadable). A print of its own is then put in the record store (scripts/records/store.ts), so the
 * next render run draws it.
 *
 * /admin/add runs it under `vite dev` (scripts/add/dev-plugin.ts). Exit 0 when the gate answered
 * (refusals included), 2 when the post couldn't be read or the add failed; the last line starts with ✓
 * or ✗. With `--json` every line goes to stderr and the last stdout line is the result as JSON
 * (`AddView`, src/lib/add-by-link.ts).
 *
 *   --plan      say what adding would do, write nothing (reads the post)
 *   --dry-run   the same as --plan
 *   --yes       don't ask before writing to prod
 *   --json      the result as JSON on stdout
 *   --dir DIR   the record store (default RECORDS_DIR, else ~/data/factorio-records)
 */
import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { printIdFor } from '#lib/print-id.js';
import { summaryOf, type AddView } from '#lib/add-by-link.js';
import { addFactoriobinPost, type Fetcher } from '#lib/server/pipeline/factoriobin.js';
import { factoriobinStoreAdapter } from './records/factoriobin';
import { pullOne } from './records/pull';
import { recordsDir } from './records/store';
import { confirmProd, openStage, parseStageArgs, requireSchema } from './stage-command';

const USAGE = 'usage: bun run add <factoriobin link> --stage local|prod [--plan] [--yes] [--json] [--dir DIR]';
const JSON_OUT = process.argv.includes('--json');
const ROOT = join(import.meta.dirname, '..');
const CACHE_DIR = join(ROOT, '.cache', 'factoriobin', 'http');
const CACHE_MS = 60 * 60 * 1000;

const toStderr = console.error.bind(console);
if (JSON_OUT) console.log = console.info = console.warn = toStderr;
const say = (line: string) => writeSync(JSON_OUT ? 2 : 1, `${line}\n`);

/** fetch, with 200 responses kept on disk an hour (posts don't change; a look-up then an add reads once). */
const cachedFetch: Fetcher = async (url, init) => {
	const base = join(CACHE_DIR, createHash('sha256').update(url).digest('hex').slice(0, 32));
	try {
		if (Date.now() - (await stat(`${base}.body`)).mtimeMs < CACHE_MS) {
			const type = await readFile(`${base}.type`, 'utf8').catch(() => 'application/octet-stream');
			return new Response(await readFile(`${base}.body`), { headers: { 'content-type': type } });
		}
	} catch {
		// Not cached.
	}
	const res = await fetch(url, init);
	if (res.status !== 200) return res;
	const body = new Uint8Array(await res.arrayBuffer());
	await mkdir(CACHE_DIR, { recursive: true });
	await writeFile(`${base}.type.tmp`, res.headers.get('content-type') ?? 'application/octet-stream');
	await rename(`${base}.type.tmp`, `${base}.type`);
	await writeFile(`${base}.body.tmp`, body);
	await rename(`${base}.body.tmp`, `${base}.body`);
	return new Response(body, { headers: { 'content-type': res.headers.get('content-type') ?? '' } });
};

const { flags, stage, generation, positionals } = parseStageArgs(
	USAGE,
	{ plan: { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, dir: { type: 'string' } },
	true
);
if (positionals.length !== 1) {
	console.error(`give one link\n${USAGE}`);
	process.exit(2);
}
const link = positionals[0];
const plan = Boolean(flags.plan || flags['dry-run']);
const dir = flags.dir ? resolve(flags.dir) : recordsDir();

let out: AddView = { ok: false, problem: 'error', message: 'did not finish', summary: '', stage, link, stored: null };
const target = await openStage(stage, generation);
let code = 0;
try {
	const env = target.env;
	await requireSchema(env.DB, stage, 'SELECT site FROM print_sources LIMIT 0', 'print_sources table', '0022');
	if (!plan) await confirmProd(stage, Boolean(flags.yes), `Add ${link} to prod?`);
	const r = await addFactoriobinPost(env, link, { fetch: cachedFetch, plan });
	let stored: string | null = null;
	if (r.ok && !r.result.planned && 'printId' in r.result && r.result.printId === printIdFor('factoriobin', r.post.id)) {
		stored = await pullOne(dir, factoriobinStoreAdapter(env), r.post.id);
	}
	const summary = summaryOf(r);
	out = { ...r, summary, stage, link, stored };
	if (r.ok) say(`${r.post.url}: ${r.post.title} (${r.post.type}, ${r.post.version ?? 'version unknown'})`);
	if (stored) say(`record store ${dir}: ${stored}`);
	say(summary);
	code = summary.startsWith('✓') ? 0 : 2;
} catch (e) {
	const message = e instanceof Error ? e.message : String(e);
	out = { ok: false, problem: 'error', message, summary: `✗ ${message}`, stage, link, stored: null };
	say(out.summary);
	code = 2;
} finally {
	await target.dispose();
}
if (JSON_OUT) writeSync(1, `${JSON.stringify(out)}\n`);
process.exit(code);
