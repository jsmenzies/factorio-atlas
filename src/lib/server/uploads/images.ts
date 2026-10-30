/**
 * The admin queue of upload screenshots (/admin/screenshots; migration 0024 `upload_images`). An image an
 * uploader sends stays private in RAW with status 'pending' and in no record; an admin approves or rejects
 * it here. The status is the image's, so it holds for every upload that sent the same bytes.
 *
 * - Approve: every upload using the image gets it in its RAW record (`upload.<id>`), and each live one is
 *   ingested again through the gate (`UploadGate.admit`: admitRecord and ingestRecord, the one ingest
 *   path), so `prints.image_id` and the analysis document name it; then the status turns 'approved' and the
 *   page cache is bumped. The status changes last, so an approval that stops part-way stays in the queue
 *   and approving again finishes it. A processing upload shows it once the sync admits it. The sync's
 *   screenshots step (`bun run screenshots --from-uploads S`) then copies approved originals from RAW and
 *   makes the sizes the site shows; until then the print shows no screenshot (#lib/screenshots.ts shotView,
 *   'preparing'), never Imgur.
 * - Reject: the status turns 'rejected' (its owners see "Screenshot not approved" and can replace it), an
 *   `image` block keeps the same bytes from coming back after the row goes (planImage refuses both), and
 *   the original is deleted from RAW: the status is the image's, so no upload can still need it.
 */
import { imageSize, sniff } from '#lib/image-header.js';
import { uploadImageId } from '#lib/screenshots.js';
import { bumpPageVersion } from '../page-cache.js';
import { insertBlocks } from '../removal-blocks.js';
import type { UploadGate } from './gate.js';
import { IMAGE_TYPES, imageKey, putRecord, readRecord, type ImageExt } from './uploads.js';

/** One upload that sent a pending image. */
export interface ImageUpload {
	print_id: string;
	title: string;
	state: 'processing' | 'live' | 'refused' | 'failed';
	shown_name: string;
}

/** A pending image as the queue shows it. */
export interface PendingImage {
	id: string;
	ext: ImageExt;
	bytes: number;
	created_at: number;
	/** The account that sent it first, and its name now; null once that account is deleted. */
	user_id: string | null;
	user_name: string | null;
	uploads: ImageUpload[];
}

/** The queue shows at most this many at once, oldest first. */
export const QUEUE_MAX = 100;

/** Pending images, oldest first (the `upload_images_status` index), each with the uploads that sent it; and how many wait in all. */
export const pendingImages = async (db: D1Database, limit = QUEUE_MAX) => {
	const [rows, count] = await db.batch<Record<string, unknown>>([
		db
			.prepare(
				`SELECT i.id, i.ext, i.bytes, i.created_at, i.user_id, a.name AS user_name,
					(SELECT json_group_array(json_object('print_id', u.print_id, 'title', u.title, 'state', u.state, 'shown_name', u.shown_name))
						FROM uploads u WHERE u.image_id = i.id) AS uploads
				FROM upload_images i LEFT JOIN users a ON a.id = i.user_id
				WHERE i.status = 'pending' ORDER BY i.created_at, i.id LIMIT ?`
			)
			.bind(limit),
		db.prepare(`SELECT count(*) AS n FROM upload_images WHERE status = 'pending'`)
	]);
	const images = (rows.results ?? []).map((r): PendingImage => ({
		id: String(r.id),
		ext: r.ext as ImageExt,
		bytes: Number(r.bytes),
		created_at: Number(r.created_at),
		user_id: (r.user_id as string | null) ?? null,
		user_name: (r.user_name as string | null) ?? null,
		uploads: JSON.parse(String(r.uploads ?? '[]')) as ImageUpload[]
	}));
	return { images, total: Number((count.results?.[0] as { n?: number } | undefined)?.n ?? images.length) };
};

/** Whether the screenshots step has sized an approved image for this stage (its `screenshots` row, migration 0019). */
export const imageCopied = async (db: D1Database, id: string) =>
	(await db.prepare(`SELECT 1 AS hit FROM screenshots WHERE image_id = ? AND state = 'copied'`).bind(uploadImageId(id)).first()) !== null;

/** An image's row, or null. */
const imageRow = (db: D1Database, id: string) =>
	db.prepare(`SELECT id, ext, status FROM upload_images WHERE id = ?`).bind(id).first<{ id: string; ext: ImageExt; status: string }>();

/** The pending original in RAW, for the admin preview: its bytes and type, or null. */
export const pendingOriginal = async (deps: { db: D1Database; raw: R2Bucket }, id: string) => {
	if (!/^[0-9a-f]{16}$/.test(id)) return null;
	const row = await imageRow(deps.db, id);
	const obj = row ? await deps.raw.get(imageKey(row.id, row.ext)) : null;
	return row && obj ? { body: obj.body, type: IMAGE_TYPES[row.ext], status: row.status } : null;
};

export type DecideResult = { ok: true; status: 'approved' | 'rejected'; uploads: number; shown: number } | { ok: false; problem: string };

export interface ApproveDeps {
	db: D1Database;
	raw: R2Bucket;
	gate: Pick<UploadGate, 'admit'>;
	now?: number;
}

/** Approve a pending image (see the header). Approving an approved image again finishes one that stopped part-way. */
export const approveImage = async (deps: ApproveDeps, id: string): Promise<DecideResult> => {
	const now = deps.now ?? Date.now();
	const row = await imageRow(deps.db, id);
	if (!row) return { ok: false, problem: 'No such screenshot.' };
	if (row.status === 'rejected') return { ok: false, problem: 'That screenshot was rejected.' };
	const key = uploadImageId(row.id);
	const uploads = (
		await deps.db
			.prepare(`SELECT print_id, state FROM uploads WHERE image_id = ? ORDER BY created_at, print_id`)
			.bind(row.id)
			.all<{ print_id: string; state: ImageUpload['state'] }>()
	).results;
	const problems: string[] = [];
	let shown = 0;
	for (const u of uploads) {
		const record = await readRecord(deps.raw, u.print_id);
		if (!record) {
			problems.push(`${u.print_id}: no record in RAW`);
			continue;
		}
		const next = { ...record, image: { key, url: '' } };
		if (record.image?.key !== key) await putRecord(deps.raw, next);
		// Processing, refused or failed uploads aren't on the site in this version: the sync admits it with the image.
		if (u.state !== 'live') continue;
		const outcome = await deps.gate.admit(next, u.print_id, [bumpPageVersion(deps.db, now)]);
		if (outcome.status === 'admitted') shown++;
		// Taken down meanwhile: nothing to show it on.
		else if (outcome.status !== 'blocked')
			problems.push(`${u.print_id}: ${outcome.status}${'reason' in outcome ? ` (${outcome.reason})` : ''}`);
	}
	if (problems.length) return { ok: false, problem: `Not approved yet, approve it again to retry: ${problems.join('; ')}` };
	await deps.db.batch([
		deps.db
			.prepare(`UPDATE upload_images SET status = 'approved', decided_at = coalesce(decided_at, ?) WHERE id = ? AND status = 'pending'`)
			.bind(now, row.id),
		bumpPageVersion(deps.db, now)
	]);
	return { ok: true, status: 'approved', uploads: uploads.length, shown };
};

/** Reject a pending image (see the header). */
export const rejectImage = async (deps: { db: D1Database; raw: R2Bucket; now?: number }, id: string): Promise<DecideResult> => {
	const now = deps.now ?? Date.now();
	const row = await imageRow(deps.db, id);
	if (!row) return { ok: false, problem: 'No such screenshot.' };
	if (row.status === 'approved') return { ok: false, problem: 'That screenshot is approved already.' };
	const first = await deps.db
		.prepare(
			`SELECT print_id, (SELECT count(*) FROM uploads WHERE image_id = ?1) AS n FROM uploads WHERE image_id = ?1 ORDER BY created_at LIMIT 1`
		)
		.bind(row.id)
		.first<{ print_id: string; n: number }>();
	await deps.db.batch([
		deps.db.prepare(`UPDATE upload_images SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'`).bind(now, row.id),
		...insertBlocks(deps.db, [
			{ kind: 'image', value: uploadImageId(row.id), print_id: first?.print_id ?? uploadImageId(row.id), report_id: null, created_at: now }
		])
	]);
	await deps.raw.delete(imageKey(row.id, row.ext));
	return { ok: true, status: 'rejected', uploads: first?.n ?? 0, shown: 0 };
};

/** How much of an original the queue reads for its size: past a JPEG's EXIF thumbnail (≤ 64 KB). */
export const HEADER_BYTES = 128 * 1024;

/** The original's size from the start of its file in RAW, or null. */
export const originalSize = async (raw: R2Bucket, id: string, ext: ImageExt) => {
	const obj = await raw.get(imageKey(id, ext), { range: { offset: 0, length: HEADER_BYTES } });
	if (!obj) return null;
	const head = new Uint8Array(await obj.arrayBuffer());
	const kind = sniff(head);
	const size = kind ? imageSize(head, kind) : null;
	return size && size.width > 0 && size.height > 0 ? { w: size.width, h: size.height } : null;
};
