/**
 * `bun run screenshots --from-sites local|prod`: the images other sites' records name (codex's and fprints'
 * `image_url`), as an input of the screenshots pipeline beside Imgur and uploads. Generic: any store site.
 *
 * Contract for a site (site-images.ts):
 * - Its SourceRecord's `image` is `siteImage(site, url)`: `{ key: '<site>.<16 hex of the URL's SHA-256>', url }`,
 *   only for https URLs on the site's image hosts (SITE_IMAGE_HOSTS). The pipeline stores the key as
 *   `prints.image_id`; the site shows nothing for it until it is copied and sized (#lib/screenshots
 *   `isOwnImage`: never the URL, never Imgur).
 * - Which images: those the stage's prints show (`prints.image_id` a site image id), each URL read from the
 *   print's archived record in RAW (`prints.raw_key`: the pipeline text's `source.image`) and checked against
 *   the id. Prints that joined another print show that print's image, so theirs are never copied.
 * - Each is copied once into the same originals folder and run state as Imgur's (its bytes never change: a
 *   new URL is a new id). 404 or 410 on two runs in a row: dead, never asked again. Anything else (5xx, a
 *   timeout, a redirect, not an image, over MAX_IMAGE_BYTES, read with a running count): failed, tried again
 *   on the next run. One the run state has as removed (a takedown)
 *   is never copied again.
 * - Polite: the importer's User-Agent (scripts/sync/polled.ts), no Referer, at most one request a second per
 *   host, 3 tries with backoff on 429/5xx/network errors. None of Imgur's checks (canary, removed.png,
 *   `--recheck`) apply.
 * From there `--make`, `--upload` and `screenshots:flags` treat them like any image. The update's screenshots
 * step runs it after `--from-uploads`.
 */
import { appendFileSync, existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isSiteImage } from '#lib/screenshots.js';
import { openTarget } from '../backfill/stage.js';
import { USER_AGENT } from '../sync/polled.js';
import type { ShotArgs } from './args.js';
import { EXT, imageSize, md5, sniff } from './image.js';
import { imageUrlOf, MAX_IMAGE_BYTES } from './site-images.js';
import { formatEntry, originalPath, type StateEntry } from './state.js';

/** One GET, body included: an image at MAX_IMAGE_BYTES needs ≈ 0.9 MB/s (codex's 97 MB one took 7 s here). */
const FETCH_TIMEOUT_MS = 120_000;

/** An image the stage's prints show: its id and the prints. */
export interface ShownImage {
	id: string;
	prints: string[];
	/** Where its archived record is in RAW (one of the prints'). */
	rawKey: string;
}

export interface SitesPlan {
	todo: ShownImage[];
	/** Copied before, file present. */
	done: number;
	/** Gone at the source before (404): not asked again. */
	dead: number;
	/** Removed since (a takedown): never copied again. */
	removed: number;
}

/** Which images still need copying. Pure. */
export function planSiteImages(
	shown: readonly ShownImage[],
	state: ReadonlyMap<string, StateEntry>,
	hasFile: (e: StateEntry) => boolean
): SitesPlan {
	const plan: SitesPlan = { todo: [], done: 0, dead: 0, removed: 0 };
	for (const s of shown) {
		const e = state.get(s.id);
		if (e?.status === 'removed') plan.removed++;
		else if (e?.status === 'dead') plan.dead++;
		else if (e?.status === 'fetched' && hasFile(e)) plan.done++;
		else plan.todo.push(s);
	}
	return plan;
}

/** The run state entry for an image's bytes, or why they can't be used. Pure. */
export function siteImageEntry(s: Pick<ShownImage, 'id' | 'prints'>, bytes: Uint8Array, at: string): StateEntry {
	const base = { id: s.id, prints: s.prints, labelled: null, attempts: 1, at };
	if (bytes.length > MAX_IMAGE_BYTES) return { ...base, status: 'failed', reason: `over ${MAX_IMAGE_BYTES / 1024 / 1024} MB` };
	const type = sniff(bytes);
	if (!type) return { ...base, status: 'failed', reason: 'not a PNG, JPEG, GIF or WebP' };
	const size = imageSize(bytes, type);
	return {
		...base,
		status: 'fetched',
		file: originalPath(s.id, EXT[type]),
		type,
		bytes: bytes.length,
		md5: md5(bytes),
		width: size?.width ?? null,
		height: size?.height ?? null
	};
}

/** One GET of an image: the bytes, or the status that ended it. Paced per host; retried on 429, 5xx and network errors. */
export function imageFetcher(
	o: { minIntervalMs?: number; tries?: number; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}
) {
	const last = new Map<string, number>();
	const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	return async (url: string): Promise<{ bytes: Uint8Array } | { status: number; reason: string }> => {
		const host = new URL(url).hostname;
		for (let attempt = 1; ; attempt++) {
			const gap = (last.get(host) ?? 0) + (o.minIntervalMs ?? 1100) - Date.now();
			if (gap > 0) await sleep(gap);
			last.set(host, Date.now());
			let res: Response;
			try {
				// No redirects: the image must be where the record says (an allowed host), not wherever it points.
				res = await (o.fetch ?? fetch)(url, {
					headers: { 'user-agent': USER_AGENT, accept: 'image/*' },
					redirect: 'manual',
					referrerPolicy: 'no-referrer',
					signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
				});
			} catch (e) {
				if (attempt >= (o.tries ?? 3)) return { status: 0, reason: e instanceof Error ? e.message : String(e) };
				await sleep(5000 * attempt);
				continue;
			}
			if (res.status >= 300 && res.status < 400) {
				await res.body?.cancel();
				return { status: res.status, reason: `redirected (HTTP ${res.status}), not followed` };
			}
			if (res.ok) {
				const over = { status: res.status, reason: `over ${MAX_IMAGE_BYTES / 1024 / 1024} MB` };
				if (Number(res.headers.get('content-length')) > MAX_IMAGE_BYTES) {
					await res.body?.cancel();
					return over;
				}
				// Read with a running count: a body longer than it said is cut off at the cap, not buffered whole.
				const chunks: Uint8Array[] = [];
				let size = 0;
				const reader = res.body?.getReader();
				for (;;) {
					const part = reader ? await reader.read() : { done: true as const, value: undefined };
					if (part.done) break;
					size += part.value.length;
					if (size > MAX_IMAGE_BYTES) {
						await reader?.cancel();
						return over;
					}
					chunks.push(part.value);
				}
				const bytes = new Uint8Array(size);
				let at = 0;
				for (const c of chunks) {
					bytes.set(c, at);
					at += c.length;
				}
				return { bytes };
			}
			await res.body?.cancel();
			if ((res.status === 429 || res.status >= 500) && attempt < (o.tries ?? 3)) {
				const after = Number(res.headers.get('retry-after'));
				await sleep(Math.min(120_000, after > 0 ? after * 1000 : 5000 * attempt));
				continue;
			}
			return { status: res.status, reason: `HTTP ${res.status}` };
		}
	};
}

/** `--from-sites` with --json: its counts as the last stdout line (the update's "From other sites" details). */
export interface FromSitesResult {
	mode: 'sites';
	stage: string;
	shown: number;
	alreadyCopied: number;
	dead: number;
	removed: number;
	toFetch: number;
	fetched: number;
	newlyDead: number;
	/** Answered 404 for the first time: not a failure, asked again next run (dead if it answers so again). */
	maybeDead: number;
	failed: number;
}

export async function runFromSites(dir: string, stateFile: string, entries: Map<string, StateEntry>, args: ShotArgs): Promise<number> {
	const stage = args.target!;
	let target;
	try {
		target = await openTarget(stage, { log: (line) => console.log(line) });
	} catch (e) {
		console.error(`screenshots: ${e instanceof Error ? e.message : String(e)}`);
		return 2;
	}
	try {
		// Ids that look like `<site>.<hex>`, then checked exactly; one row per image, with every print showing it.
		const { results } = await target.env.DB.prepare(
			`SELECT image_id, json_group_array(id) AS prints, MIN(raw_key) AS raw_key FROM prints
			WHERE image_id LIKE '%.%' AND image_id NOT LIKE 'upload.%' GROUP BY image_id ORDER BY MIN(ingested_at), image_id`
		).all<{ image_id: string; prints: string; raw_key: string }>();
		let shown: ShownImage[] = results
			.filter((r) => isSiteImage(r.image_id))
			.map((r) => ({ id: r.image_id, prints: JSON.parse(r.prints) as string[], rawKey: r.raw_key }));
		if (args.ids) {
			const asked = new Set(args.ids);
			shown = shown.filter((s) => asked.has(s.id) || s.prints.some((p) => asked.has(p)));
		}
		const plan = planSiteImages(shown, entries, (e) => !!e.file && existsSync(join(dir, e.file)));
		const todo = args.limit ? plan.todo.slice(0, args.limit) : plan.todo;
		console.log(
			`screenshots: ${shown.length} images from other sites shown in ${stage}: ${plan.done} already copied, ${plan.dead} dead, ` +
				`${plan.removed} removed; to copy ${plan.todo.length}${args.limit ? `, this run ${todo.length}` : ''} → ${dir}`
		);
		const get = imageFetcher();
		let fetched = 0;
		let newlyDead = 0;
		let maybeDead = 0;
		const failed: string[] = [];
		if (!args.planOnly) {
			for (const s of todo) {
				const at = new Date().toISOString();
				const settle = (status: 'dead' | 'failed', reason: string): StateEntry => ({
					id: s.id,
					prints: s.prints,
					labelled: null,
					attempts: 1,
					at,
					status,
					reason
				});
				let entry: StateEntry;
				try {
					const obj = await target.env.RAW.get(s.rawKey);
					const url = obj ? imageUrlOf(await obj.text(), s.id) : null;
					if (!url) entry = settle('failed', `no URL for it in ${s.rawKey}`);
					else {
						const got = await get(url);
						if ('bytes' in got) {
							entry = siteImageEntry(s, got.bytes, at);
							if (entry.status === 'fetched') {
								// Through a temp file and a rename, before its line: a `fetched` line always names a whole file.
								const path = join(dir, entry.file!);
								const tmp = `${path}.tmp-${process.pid}`;
								await mkdir(dirname(path), { recursive: true });
								try {
									await writeFile(tmp, got.bytes);
									await rename(tmp, path);
								} catch (e) {
									await rm(tmp, { force: true });
									throw e;
								}
							}
						} else {
							// Gone at the source only when it answered so on an earlier run too: one 404 may be a blip.
							const gone = got.status === 404 || got.status === 410;
							const before = entries.get(s.id);
							const twice = gone && before?.status === 'failed' && /^HTTP 4(04|10) /.test(before.reason ?? '');
							entry = settle(
								twice ? 'dead' : 'failed',
								`${got.reason} from ${new URL(url).host}${gone && !twice ? ' (dead if again next run)' : ''}`
							);
						}
					}
				} catch (e) {
					entry = settle('failed', e instanceof Error ? e.message : String(e));
				}
				appendFileSync(stateFile, formatEntry(entry));
				if (entry.status === 'fetched') fetched++;
				else if (entry.status === 'dead') newlyDead++;
				// A first 404 is not a failure of the run: the image is maybe dead, asked once more next run.
				else if (entry.reason?.endsWith('(dead if again next run)')) maybeDead++;
				else failed.push(`${entry.id}: ${entry.reason}`);
				console.log(`screenshots: ${s.id} (${s.prints[0]}): ${entry.status}${entry.reason ? ` (${entry.reason})` : ''}`);
			}
			console.log(
				`screenshots: copied ${fetched} images from other sites, ${newlyDead} gone at the source, ${maybeDead} answered 404 once (asked again next run), failed ${failed.length}`
			);
		}
		if (args.json)
			console.log(
				JSON.stringify({
					mode: 'sites',
					stage,
					shown: shown.length,
					alreadyCopied: plan.done,
					dead: plan.dead,
					removed: plan.removed,
					toFetch: plan.todo.length,
					fetched,
					newlyDead,
					maybeDead,
					failed: failed.length
				} satisfies FromSitesResult)
			);
		return failed.length ? 1 : 0;
	} catch (e) {
		console.error(`screenshots: ${e instanceof Error ? e.message : String(e)}`);
		return 2;
	} finally {
		await target.dispose();
	}
}
