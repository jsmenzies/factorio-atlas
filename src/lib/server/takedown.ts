/**
 * Deleting a print from a stage, in the site Worker (plans: ingest-and-delete, removal-requests).
 *
 * `purgePrintData` deletes everything the stage holds for a print and leaves a tombstone; it blocks
 * nothing. Owners deleting uploads and prints gone from every source use it alone. `takedownPrint`
 * (an approved removal request) writes `removal_blocks` too, so the print never comes back. Both are
 * idempotent: one cut short is finished by running it again.
 *
 * The order keeps a print that is part-way deleted from ever being cached as live again:
 * 1. One D1 batch: (blocks,) the tombstone. From here a 'takedown' print's pages answer 410 on every
 *    cache miss (loadPrintDoc reads the tombstone), and the `prints_not_removed` trigger refuses its row.
 * 2. RAW: the analysis document first (the print, render and string pages read only R2), then the
 *    archived record and the viewer files.
 * 3. One D1 batch: the print's rows (prints, print_search, print_items, print_uses, print_renders,
 *    ingest_state), the screenshot's row when it goes, the tombstone again (an
 *    ingest that raced a 'gone' purge deletes it). From here search and the sitemap drop it.
 * 4. RENDERS: every key under `<id>/` (overviews, tiles, sidecars, page data, thumbnails, indexes).
 * 5. SCREENSHOTS: the image's files and a 'removed' manifest, when the image goes: a takedown's image goes
 *    when no other print uses it, or with `screenshotToo` (the request was about it), or when an earlier
 *    run of the same takedown already blocked it; a 'gone' print's image goes only with `screenshotToo`
 *    (and is never recorded in `screenshot_removals`, which would keep it out for good).
 * 6. The edge cache: the renders folder by prefix and the screenshot's files by URL (they are cached for a
 *    year), with CACHE_PURGE_TOKEN and CACHE_ZONE_ID; else the result lists what to purge. The URLs are
 *    worked out before the files go, and a caller may pass the list an earlier run couldn't purge
 *    (`purgeAlso`), so a retry purges what a listing can no longer find.
 * 7. Last, whether or not it got there: a new page-cache version, so cached pages are made again (as
 *    410 for a takedown, whatever R2 still holds).
 *
 * The machine that renders still has its own copies and queue rows: `bun run removals` sweeps them,
 * from the tombstones.
 */
import { manifestKey, type ShotManifest } from '#lib/screenshots.js';
import { bumpPageVersion } from './page-cache';
import { analysisKey } from './pipeline/print-doc';
import { insertBlocks, printBlocks, type Block, type BlockRow } from './removal-blocks';
import { removalRecordStatements, removedRowStatement } from './screenshot-flags';

export interface TakedownEnv {
	readonly DB: D1Database;
	readonly RAW: R2Bucket;
	readonly RENDERS: R2Bucket;
	readonly SCREENSHOTS: R2Bucket;
	readonly RENDERS_URL: string;
	readonly SCREENSHOTS_URL: string;
	readonly CACHE_PURGE_TOKEN?: string;
	readonly CACHE_ZONE_ID?: string;
}

export type TombstoneKind = 'takedown' | 'gone';

export interface PurgeOptions {
	readonly kind: TombstoneKind;
	/** Take the screenshot down even when other prints use it (the request was about the image). */
	readonly screenshotToo?: boolean;
	/** What an earlier run of the same deletion couldn't purge from the edge cache: purged with this run's. */
	readonly purgeAlso?: PurgeList;
	readonly now?: number;
}

export interface PurgeList {
	readonly prefixes: readonly string[];
	readonly urls: readonly string[];
}

export interface TakedownResult {
	readonly d1Rows: number;
	readonly rawObjects: number;
	readonly renderObjects: number;
	/**
	 * 'removed': its files went; 'shared': other prints use it, so it stays; 'kept': a 'gone' print's image,
	 * left as it is; 'none': the print had none.
	 */
	readonly screenshot: 'removed' | 'shared' | 'kept' | 'none';
	readonly screenshotObjects: number;
	/** What the edge cache must forget (with `purgeAlso`): done when `purged`, else to purge again or by hand. */
	readonly purge: { readonly prefixes: string[]; readonly urls: string[] };
	/** Every prefix and URL purged, or nothing to purge. */
	readonly purged: boolean;
	/** Why not: the purge API's error, or that the stage has no purge token. */
	readonly purgeError: string | null;
}

/**
 * A deletion that stopped part-way, with what the edge cache must still forget (as far as it got: the
 * screenshot's URLs once it listed them, and `purgeAlso`), so a retry can purge what it can no longer list.
 */
export class TakedownError extends Error {
	constructor(
		message: string,
		readonly purge: PurgeList,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = 'TakedownError';
	}
}

/** Every key under `prefix`, listed 1,000 at a time. */
export const listKeys = async (bucket: R2Bucket, prefix: string) => {
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, cursor, limit: 1000 });
		keys.push(...page.objects.map((o) => o.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return keys;
};

/**
 * Delete every key under `prefix` but those `keep` names: listed in full first, so no deletion can move
 * a listing cursor, then deleted 1,000 at a time (R2's limit per call).
 */
export const deletePrefix = async (bucket: R2Bucket, prefix: string, keep: (key: string) => boolean = () => false) => {
	const keys = (await listKeys(bucket, prefix)).filter((k) => !keep(k));
	for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
	return keys.length;
};

/** The image the print showed, from its row, else from a block an earlier, cut-short takedown wrote. */
const imageOf = async (db: D1Database, printId: string) => {
	const row = await db.prepare('SELECT image_id FROM prints WHERE id = ?').bind(printId).first<{ image_id: string | null }>();
	if (row?.image_id) return row.image_id;
	const block = await db
		.prepare(`SELECT value FROM removal_blocks WHERE print_id = ? AND kind = 'image' LIMIT 1`)
		.bind(printId)
		.first<{ value: string }>();
	return block?.value ?? null;
};

const otherUsers = async (db: D1Database, image: string, printId: string) =>
	(await db.prepare('SELECT count(*) AS n FROM prints WHERE image_id = ? AND id != ?').bind(image, printId).first<{ n: number }>())?.n ?? 0;

/** A hostname + path prefix for Cloudflare's purge API, from a `https://host` base. */
const hostPath = (base: string, path: string) => `${base.replace(/^https?:\/\//, '')}/${path}`;

/** Cloudflare's purge API: prefixes and URLs, at most 100 of each kind per request on every plan. */
const purgeCache = async (token: string, zoneId: string, { prefixes, urls }: PurgeList) => {
	const send = async (body: Record<string, string[]>) => {
		const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) throw new Error(`purge_cache answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
	};
	for (let i = 0; i < prefixes.length; i += 100) await send({ prefixes: prefixes.slice(i, i + 100) });
	for (let i = 0; i < urls.length; i += 100) await send({ files: urls.slice(i, i + 100) });
};

/** The print's image and whether this deletion takes it down (see the header, step 5). */
const screenshotFate = async (db: D1Database, printId: string, kind: TombstoneKind, screenshotToo: boolean) => {
	const image = await imageOf(db, printId);
	if (image === null) return { image, fate: 'none' as const };
	if (screenshotToo) return { image, fate: 'removed' as const };
	if (kind === 'gone') return { image, fate: 'kept' as const };
	const blocked = await db
		.prepare(`SELECT 1 AS hit FROM removal_blocks WHERE kind = 'image' AND value = ? AND print_id = ?`)
		.bind(image, printId)
		.first();
	return { image, fate: blocked || (await otherUsers(db, image, printId)) === 0 ? ('removed' as const) : ('shared' as const) };
};

const tombstone = (db: D1Database, printId: string, kind: TombstoneKind, now: number) =>
	// A takedown's tombstone is never turned back into 'gone'.
	db
		.prepare(
			`INSERT INTO print_tombstones (print_id, kind, at) VALUES (?, ?, ?)
			ON CONFLICT (print_id) DO UPDATE SET kind = CASE WHEN kind = 'takedown' THEN kind ELSE excluded.kind END, at = excluded.at`
		)
		.bind(printId, kind, now);

const unique = (xs: readonly string[]) => [...new Set(xs)];

/** Delete every copy of a print in this stage and leave a tombstone; no blocks (see the header). */
export const purgePrintData = async (env: TakedownEnv, printId: string, options: PurgeOptions) =>
	purge(env, printId, options, [], await screenshotFate(env.DB, printId, options.kind, options.screenshotToo ?? false));

async function purge(
	env: TakedownEnv,
	printId: string,
	options: PurgeOptions,
	blocks: BlockRow[],
	{ image, fate }: Awaited<ReturnType<typeof screenshotFate>>
): Promise<TakedownResult> {
	const now = options.now ?? Date.now();
	const db = env.DB;
	let bumped = false;
	const prefixes = unique([...(env.RENDERS_URL ? [hostPath(env.RENDERS_URL, `${printId}/`)] : []), ...(options.purgeAlso?.prefixes ?? [])]);
	const urls: string[] = [...(options.purgeAlso?.urls ?? [])];
	try {
		// 1. Blocks and tombstone.
		await db.batch([...insertBlocks(db, blocks), tombstone(db, printId, options.kind, now)]);

		// 2. RAW, the analysis document first.
		await env.RAW.delete(analysisKey(printId));
		const rawKeys = [`factorioprints/${printId}.json`];
		await env.RAW.delete(rawKeys);
		const rawObjects = 1 + rawKeys.length + (await deletePrefix(env.RAW, `viewer/${printId}/`));

		// 3. The print's rows.
		const shotRows =
			fate === 'removed' && image
				? options.kind === 'takedown'
					? removalRecordStatements(db, image, printId, 'print taken down', now)
					: [removedRowStatement(db, image, now)]
				: [];
		const results = await db.batch([
			db.prepare('DELETE FROM print_search WHERE print_id = ?').bind(printId),
			db.prepare('DELETE FROM print_items WHERE print_id = ?').bind(printId),
			db.prepare('DELETE FROM print_uses WHERE print_id = ?').bind(printId),
			db.prepare('DELETE FROM print_renders WHERE print_id = ?').bind(printId),
			db.prepare('DELETE FROM prints WHERE id = ?').bind(printId),
			db.prepare('DELETE FROM ingest_state WHERE print_id = ?').bind(printId),
			...shotRows,
			// Other per-print rows go here, before the tombstone (dedup: its identity rows).
			tombstone(db, printId, options.kind, now)
		]);
		const d1Rows = results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);

		// 4. Renders.
		const renderObjects = await deletePrefix(env.RENDERS, `${printId}/`);

		// 5. The screenshot: its URLs worked out from the listing before anything is deleted, and the files
		// deleted last, so nothing that can fail comes between their deletion and the purge.
		let screenshotObjects = 0;
		if (fate === 'removed' && image) {
			const manifest = manifestKey(image);
			const keys = (await listKeys(env.SCREENSHOTS, `${image}.`)).filter((k) => k !== manifest);
			if (env.SCREENSHOTS_URL) urls.push(...[...keys, manifest].map((k) => `${env.SCREENSHOTS_URL}/${k}`));
			await env.SCREENSHOTS.put(manifest, JSON.stringify({ state: 'removed' } satisfies ShotManifest), {
				httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=300' }
			});
			if (keys.length) await env.SCREENSHOTS.delete(keys);
			screenshotObjects = keys.length;
		}

		// 6. The edge cache.
		const purge = { prefixes, urls: unique(urls) };
		let purged = purge.prefixes.length + purge.urls.length === 0;
		let purgeError: string | null = null;
		if (!purged && !(env.CACHE_PURGE_TOKEN && env.CACHE_ZONE_ID)) purgeError = 'no purge token on this stage';
		else if (!purged) {
			try {
				await purgeCache(env.CACHE_PURGE_TOKEN!, env.CACHE_ZONE_ID!, purge);
				purged = true;
			} catch (e) {
				purgeError = e instanceof Error ? e.message : String(e);
			}
		}

		// 7. Cached pages are made again, after the R2 work (see the header).
		await bumpPageVersion(db, now).run();
		bumped = true;
		return { d1Rows, rawObjects, renderObjects, screenshot: fate, screenshotObjects, purge, purged, purgeError };
	} catch (e) {
		throw new TakedownError(e instanceof Error ? e.message : String(e), { prefixes, urls: unique(urls) }, { cause: e });
	} finally {
		// Cut short: bump anyway (a takedown's pages answer 410 once the tombstone is in), but a failed bump
		// never hides why it stopped.
		if (!bumped) {
			await bumpPageVersion(db, now)
				.run()
				.catch(() => {});
		}
	}
}

/**
 * An approved removal: block the print (its id, its factorioprints source and, when it goes, its image),
 * then purge it. `reportId` is the request approved, null when an admin removed it.
 */
export async function takedownPrint(
	env: TakedownEnv,
	printId: string,
	reportId: string | null,
	options: Omit<PurgeOptions, 'kind'> = {}
): Promise<TakedownResult> {
	const now = options.now ?? Date.now();
	const fate = await screenshotFate(env.DB, printId, 'takedown', options.screenshotToo ?? false);
	const blocks: Block[] = [
		...printBlocks(printId),
		...(fate.fate === 'removed' && fate.image ? [{ kind: 'image' as const, value: fate.image }] : [])
		// More blocks go here, read before the purge deletes what they come from (dedup: the print's other
		// `source` rows, and its page and book hashes as 'sha256').
	];
	const rows: BlockRow[] = blocks.map((b) => ({ ...b, print_id: printId, report_id: reportId, created_at: now }));
	return purge(env, printId, { ...options, kind: 'takedown', now }, rows, fate);
}
