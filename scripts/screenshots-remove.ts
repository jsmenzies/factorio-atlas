/**
 * `bun run screenshots:remove --stage local|prod --ids=<print or Imgur ids> [--reason TEXT]`: take
 * screenshots down on request (the "Remove a screenshot" issue form), at once:
 *
 * 1. the run state (state.jsonl) marks each image removed, so no later fetch or upload brings it back;
 * 2. the stage's bucket gets a 'removed' manifest and loses every file of the image, with no grace
 *    period (recorded in the upload ledger);
 * 3. the stage's D1 records it in `screenshot_removals` and sets its `screenshots` row 'removed' (also
 *    for an image never copied), so neither our copy nor Imgur's is shown anywhere, and cached pages
 *    are purged.
 *
 * Images are copied once per Imgur id, so a print id takes down that image for every print that
 * uses it. Cloudflare's edge may keep serving a deleted file at its old address until it is purged:
 * the script prints those addresses to purge in the dashboard (Caching → Configuration → Custom Purge).
 *
 *   --dry-run     show what would be removed, change nothing
 *   --yes         don't ask before writing to prod
 */
import { appendFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { manifestKey } from '#lib/screenshots.js';
import { removalStatements } from '#lib/server/screenshot-flags.js';
import { screenshotsDir } from './screenshots/args.js';
import { formatLine, ledgerFile, readLedger, type LedgerLine } from './screenshots/ledger.js';
import { IMGUR_ID, PRINT_ID } from './screenshots/records.js';
import { formatEntry, parseState, STATE_FILE, type StateEntry } from './screenshots/state.js';
import { openShotStore } from './screenshots/store.js';
import { syncImage } from './screenshots/upload.js';
import { confirmProd, fail, openStage, parseStageArgs, requireSchema } from './stage-command';

const USAGE =
	'usage: bun run screenshots:remove --stage local|prod --ids=<print or Imgur ids, comma-separated> [--reason TEXT] [--dry-run] [--yes]';

const { flags, stage, generation } = parseStageArgs(USAGE, { ids: { type: 'string' }, reason: { type: 'string' } });
const ids = (flags.ids ?? '')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);
if (!ids.length) fail(`--ids is required\n${USAGE}`);
const bad = ids.filter((id) => !PRINT_ID.test(id) && !IMGUR_ID.test(id));
if (bad.length) fail(`not a print or Imgur id: ${bad.join(', ')}`);
const reason = flags.reason?.trim() || null;

const dir = screenshotsDir(join(import.meta.dirname, '..'));
const stateFile = join(dir, STATE_FILE);
const ledger = join(dir, ledgerFile(stage));
const { entries } = parseState(await readFile(stateFile, 'utf8').catch(() => ''));
const { held } = readLedger(await readFile(ledger, 'utf8').catch(() => ''));

// One process, one set of bindings: locally the store's proxy also gives the D1.
const opened = await openShotStore(stage).catch((e: unknown) => fail(`✗ ${e instanceof Error ? e.message : String(e)}`));
const target = stage === 'local' ? null : await openStage(stage, generation);
const db = (opened.db ?? target?.env.DB)!;
const dispose = async () => {
	await opened.dispose();
	await target?.dispose();
};

try {
	await requireSchema(db, stage, 'SELECT image_id FROM screenshot_removals LIMIT 0', 'screenshot_removals table', '0019');
	// Print ids → their image (and the print, recorded with the removal).
	const images = new Map<string, string | null>();
	for (const id of ids) {
		if (IMGUR_ID.test(id)) images.set(id, images.get(id) ?? null);
		else {
			const row = await db.prepare('SELECT image_id FROM prints WHERE id = ?').bind(id).first<{ image_id: string | null }>();
			if (!row?.image_id) throw new Error(`print ${id} isn't in the ${stage} D1, or has no screenshot`);
			images.set(row.image_id, id);
		}
	}
	for (const [image, print] of images) {
		const h = held.get(image);
		console.log(
			`${image}${print ? ` (print ${print})` : ''}: ${h ? `${h.keys.size} files and its manifest in the bucket` : 'nothing in the bucket yet'}; ` +
				`prints using it here: ${(entries.get(image)?.prints ?? []).join(', ') || 'unknown'}`
		);
	}
	if (flags['dry-run']) {
		console.log('dry run; nothing changed');
	} else {
		await confirmProd(stage, flags.yes, `Remove ${images.size} screenshot(s) from PROD?`);
		await mkdir(dirname(ledger), { recursive: true });
		const append = (l: LedgerLine) => appendFileSync(ledger, formatLine(l));
		const purge: string[] = [];
		const base =
			(stage === 'prod' && process.env.SCREENSHOTS_DOMAIN_PROD?.trim() && `https://${process.env.SCREENSHOTS_DOMAIN_PROD.trim()}`) ||
			'/screenshots';
		const now = Date.now();
		for (const [image, print] of images) {
			const before = entries.get(image);
			const entry: StateEntry = {
				...(before ?? { id: image, prints: print ? [print] : [], labelled: null, attempts: 0 }),
				status: 'removed',
				by: 'request',
				reason: `removal request${reason ? `: ${reason}` : ''}`,
				at: new Date(now).toISOString()
			};
			appendFileSync(stateFile, formatEntry(entry));
			const keys = [...(held.get(image)?.keys ?? [])];
			await syncImage({ dir, store: opened.store, held, append }, entry, null);
			purge.push(...keys.map((k) => `${base}/${k}`), `${base}/${manifestKey(image)}`);
			await db.batch(removalStatements(db, image, print, reason, now));
		}
		console.log(`✓ removed ${images.size} screenshot(s) from ${stage}: files deleted, manifest and row 'removed', cached pages purged`);
		console.log("Purge these from Cloudflare's cache (dashboard → Caching → Configuration → Custom Purge → URL):");
		for (const u of purge) console.log(`  ${u}`);
	}
} catch (e) {
	await dispose();
	fail(`✗ ${e instanceof Error ? e.message : String(e)}`);
}
await dispose();
process.exit(0);
