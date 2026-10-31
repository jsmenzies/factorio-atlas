/**
 * `bun run screenshots --from-uploads local|prod`: the stage's approved upload screenshots (migration 0024
 * `upload_images`, status 'approved') as an input beside Imgur. Each original is copied from the stage's
 * private RAW bucket (`upload-images/<16 hex>.<ext>`; prod through the backfill's Node sidecar) into the
 * same originals folder and run state as Imgur's, under the image id `upload.<16 hex>`. From there
 * `--make`, `--upload` and `screenshots:flags` treat it like any other image: the same sizes,
 * SCREENSHOT_VERSION names, SCREENSHOTS bucket, manifests and `screenshots` rows.
 *
 * An image is copied once (its bytes never change: the id is their hash, checked on the way in); one the
 * run state has as removed (a takedown, `bun run removals`) is never copied again. Imgur is never asked
 * anything about these.
 */
import { appendFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isUploadImage, uploadImageId } from '#lib/screenshots.js';
import { IMAGE_TYPES, imageKey, type ImageExt } from '#lib/server/uploads/uploads.js';
import { openTarget } from '../backfill/stage.js';
import type { ShotArgs } from './args.js';
import { EXT, imageSize, md5, sniff } from './image.js';
import { formatEntry, originalPath, type StateEntry } from './state.js';

/** An approved upload image, as the stage's D1 has it. */
export interface ApprovedImage {
	/** The 16 hex of `upload_images.id`. */
	id: string;
	ext: ImageExt;
	sha256: string;
	/** The uploads that use it (their print ids). */
	prints: string[];
}

export interface UploadsPlan {
	todo: ApprovedImage[];
	/** Copied before, file present. */
	done: number;
	/** Removed since (a takedown): never copied again. */
	removed: number;
}

/** Which approved images still need copying, in `approved`'s order. Pure. */
export function planUploadImages(
	approved: readonly ApprovedImage[],
	state: ReadonlyMap<string, StateEntry>,
	hasFile: (e: StateEntry) => boolean
): UploadsPlan {
	const plan: UploadsPlan = { todo: [], done: 0, removed: 0 };
	for (const a of approved) {
		const e = state.get(uploadImageId(a.id));
		if (e?.status === 'removed') plan.removed++;
		else if (e?.status === 'fetched' && hasFile(e)) plan.done++;
		else plan.todo.push(a);
	}
	return plan;
}

/** Whether a run state entry is an upload image's (not Imgur's): never asked of Imgur. */
export const isUploadEntry = (e: Pick<StateEntry, 'id'>) => isUploadImage(e.id);

/** The run state entry for an original copied from RAW, or why it can't be used. */
export function uploadEntry(a: ApprovedImage, bytes: Uint8Array, at: string): StateEntry {
	const id = uploadImageId(a.id);
	const base = { id, prints: a.prints, labelled: IMAGE_TYPES[a.ext], attempts: 1, at };
	const sha = createHash('sha256').update(bytes).digest('hex');
	if (sha !== a.sha256)
		return { ...base, status: 'failed', reason: `bytes don't match the SHA-256 the upload recorded (${sha.slice(0, 16)})` };
	const type = sniff(bytes);
	if (!type) return { ...base, status: 'failed', reason: 'not a PNG, JPEG, GIF or WebP' };
	const size = imageSize(bytes, type);
	return {
		...base,
		status: 'fetched',
		file: originalPath(id, EXT[type]),
		type,
		bytes: bytes.length,
		md5: md5(bytes),
		width: size?.width ?? null,
		height: size?.height ?? null
	};
}

/** `--from-uploads` with --json: its counts as the last stdout line (the update's "From uploads" details). */
export interface FromUploadsResult {
	mode: 'uploads';
	stage: string;
	approved: number;
	alreadyCopied: number;
	removed: number;
	toFetch: number;
	fetched: number;
	failed: number;
}

export async function runFromUploads(dir: string, stateFile: string, entries: Map<string, StateEntry>, args: ShotArgs): Promise<number> {
	const stage = args.target!;
	let target;
	try {
		target = await openTarget(stage, { log: (line) => console.log(line) });
	} catch (e) {
		console.error(`screenshots: ${e instanceof Error ? e.message : String(e)}`);
		return 2;
	}
	try {
		const { results } = await target.env.DB.prepare(
			`SELECT i.id, i.ext, i.sha256, (SELECT json_group_array(u.print_id) FROM uploads u WHERE u.image_id = i.id) AS prints
			FROM upload_images i WHERE i.status = 'approved' ORDER BY i.created_at, i.id`
		)
			.all<{ id: string; ext: ImageExt; sha256: string; prints: string }>()
			.catch((e: unknown) => {
				throw new Error(`the ${stage} D1 database has no upload_images table (migration 0024): ${e instanceof Error ? e.message : e}`);
			});
		let approved: ApprovedImage[] = results.map((r) => ({
			id: r.id,
			ext: r.ext,
			sha256: r.sha256,
			prints: JSON.parse(r.prints) as string[]
		}));
		if (args.ids) {
			const asked = new Set(args.ids);
			approved = approved.filter((a) => asked.has(uploadImageId(a.id)) || a.prints.some((p) => asked.has(p)));
		}
		const plan = planUploadImages(approved, entries, (e) => !!e.file && existsSync(join(dir, e.file)));
		const todo = args.limit ? plan.todo.slice(0, args.limit) : plan.todo;
		console.log(
			`screenshots: ${approved.length} approved upload screenshots in ${stage}: ${plan.done} already copied, ${plan.removed} removed; ` +
				`to copy ${plan.todo.length}${args.limit ? `, this run ${todo.length}` : ''} → ${dir}`
		);
		let fetched = 0;
		const failed: string[] = [];
		if (!args.planOnly) {
			for (const a of todo) {
				const at = new Date().toISOString();
				const failure = (reason: string): StateEntry => ({
					id: uploadImageId(a.id),
					prints: a.prints,
					labelled: IMAGE_TYPES[a.ext],
					attempts: 1,
					at,
					status: 'failed',
					reason
				});
				let entry: StateEntry;
				try {
					const obj = await target.env.RAW.get(imageKey(a.id, a.ext));
					const bytes = obj ? new Uint8Array(await obj.arrayBuffer()) : null;
					entry = bytes ? uploadEntry(a, bytes, at) : failure('no original in RAW');
					if (bytes && entry.status === 'fetched') {
						// Through a temp file and a rename, before its line: a `fetched` line always names a whole file.
						const path = join(dir, entry.file!);
						const tmp = `${path}.tmp-${process.pid}`;
						await mkdir(dirname(path), { recursive: true });
						try {
							await writeFile(tmp, bytes);
							await rename(tmp, path);
						} catch (e) {
							await rm(tmp, { force: true });
							throw e;
						}
					}
				} catch (e) {
					entry = failure(e instanceof Error ? e.message : String(e));
				}
				appendFileSync(stateFile, formatEntry(entry));
				if (entry.status === 'fetched') fetched++;
				else failed.push(`${entry.id}: ${entry.reason}`);
			}
			console.log(`screenshots: copied ${fetched} upload screenshots from ${stage}, failed ${failed.length}`);
			for (const f of failed.slice(0, 20)) console.log(`  ${f}`);
		}
		if (args.json)
			console.log(
				JSON.stringify({
					mode: 'uploads',
					stage,
					approved: approved.length,
					alreadyCopied: plan.done,
					removed: plan.removed,
					toFetch: plan.todo.length,
					fetched,
					failed: failed.length
				} satisfies FromUploadsResult)
			);
		return failed.length ? 1 : 0;
	} catch (e) {
		console.error(`screenshots: ${e instanceof Error ? e.message : String(e)}`);
		return 2;
	} finally {
		await target.dispose();
	}
}
