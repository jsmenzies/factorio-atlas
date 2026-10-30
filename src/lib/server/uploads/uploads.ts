/**
 * Uploads (migration 0024): a signed-in account posts a blueprint string, a title, a description and
 * optionally a screenshot. The upload is a SourceRecord of the site `upload`, kept in RAW at
 * `upload/<site id>.json` as the pipeline's own text for it (`toPipelineText`, the only copy: the
 * pipeline archives the same text there when it ingests, and the sync's Bun ingest reads it back with
 * `fromPipelineText`), admitted through the shared gate and ingested by the shared pipeline (gate.ts);
 * uploads keep only their own rows and the pending image. A pending screenshot is never in the record:
 * the print shows one only once an admin approves it (`upload.<id>`).
 *
 * Order of writes, so a Worker stopped half-way leaves nothing the sync can't finish: the image and
 * the record go to RAW first; the gate then admits and ingests the print with uploads' rows in the same
 * D1 batch (state 'live'); an upload over the Worker's cap gets its rows as 'processing' instead, for
 * the next sync's Bun ingest. A refused upload's RAW objects are deleted again (an edit's record is put
 * back as it was).
 */
import { printIdFor, siteOfPrintId } from '#lib/print-id.js';
import { deleteAccount, markDeleting, type Account } from '../auth/users.js';
import { bumpPageVersion } from '../page-cache.js';
import { analysisKey, withAuthorName } from '../pipeline/print-doc.js';
import { fromPipelineText, rawKeyFor, toPipelineText, type SourceRecord } from '../pipeline/source-record.js';
import type { GateOutcome, PurgeExtras, Suggestion, UploadGate } from './gate.js';

export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 20_000;
/** The largest string accepted at all; the Worker's own cap (512 KB) is the gate's, which sends bigger ones to the sync. */
export const STRING_MAX_BYTES = 12 * 1024 * 1024;
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** Per account per UTC day (`upload_quota`). */
export const UPLOADS_PER_DAY = 20;
export const EDITS_PER_DAY = 50;
export const IMAGES_PER_DAY = 10;
/** The sync's tries at a processing upload before it gives up ('failed'). */
export const PROCESSING_ATTEMPTS = 3;
/** Uploads waiting for the sync because they are over the Worker's cap, per account. */
export const PROCESSING_MAX = 5;
const DAY_MS = 86_400_000;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** 10 base62 characters from crypto randomness (bytes ≥ 248 are skipped, so every character is equally likely). */
export const newSiteId = () => {
	let out = '';
	while (out.length < 10) {
		for (const b of crypto.getRandomValues(new Uint8Array(16))) {
			if (b < 248 && out.length < 10) out += BASE62[b % 62];
		}
	}
	return out;
};

export const printIdOf = (siteId: string) => printIdFor('upload', siteId);
export const siteIdOf = (printId: string) => printId.slice(printId.indexOf('-') + 1);
/** Whether `printId` is an upload's (`up-` and 10 base62 characters). */
export const isUploadId = (printId: string) => siteOfPrintId(printId) === 'upload';
export const recordKey = (siteId: string) => rawKeyFor('upload', siteId);
export const imageKey = (id: string, ext: string) => `upload-images/${id}.${ext}`;

export type ImageExt = 'png' | 'jpg' | 'webp' | 'gif';
export const IMAGE_TYPES: Record<ImageExt, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/** The image's type from its first bytes (never the browser's word), or null when it isn't one we take. */
export const sniffImage = (b: Uint8Array): ImageExt | null => {
	const at = (i: number, ...bytes: number[]) => bytes.every((x, j) => b[i + j] === x);
	if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
	if (at(0, 0xff, 0xd8, 0xff)) return 'jpg';
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp';
	if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'gif';
	return null;
};

export const sha256Hex = async (bytes: Uint8Array | string) =>
	[
		...new Uint8Array(
			await crypto.subtle.digest('SHA-256', (typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes) as BufferSource)
		)
	]
		.map((x) => x.toString(16).padStart(2, '0'))
		.join('');

/** What the form sends. `image`: new bytes, none (a new upload without one), or for an edit keep or remove the current one. */
export interface UploadInput {
	title: string;
	description: string;
	blueprintString: string;
	image: Uint8Array | null | 'keep' | 'remove';
}

/** No control characters but newlines and tabs, no bidi embeddings, overrides or isolates; trimmed. */
const clean = (s: string, multiline: boolean) =>
	(multiline ? s.replace(/\r\n?/g, '\n') : s.replace(/\s+/g, ' '))
		.replace(/[^\P{Cc}\n\t]/gu, '')
		.replace(/[‪-‮⁦-⁩]/g, '')
		.trim();

/** The input cleaned, or the first thing wrong with it. */
export const checkInput = (input: UploadInput): { ok: true; value: UploadInput } | { ok: false; problem: string } => {
	const title = clean(input.title, false);
	const description = clean(input.description, true);
	const blueprintString = input.blueprintString.trim();
	if (!title) return { ok: false, problem: 'Give it a title.' };
	if ([...title].length > TITLE_MAX) return { ok: false, problem: `Titles are at most ${TITLE_MAX} characters.` };
	if ([...description].length > DESCRIPTION_MAX)
		return { ok: false, problem: `Descriptions are at most ${DESCRIPTION_MAX.toLocaleString('en')} characters.` };
	if (!blueprintString) return { ok: false, problem: 'Paste the blueprint string.' };
	if (new TextEncoder().encode(blueprintString).byteLength > STRING_MAX_BYTES)
		return { ok: false, problem: `Blueprint strings are at most ${STRING_MAX_BYTES / 1024 / 1024} MB.` };
	if (!/^0[A-Za-z0-9+/=\s]+$/.test(blueprintString) && !blueprintString.startsWith('{'))
		return { ok: false, problem: 'That doesn’t look like a Factorio blueprint string (they start with 0).' };
	if (input.image instanceof Uint8Array) {
		if (input.image.byteLength > IMAGE_MAX_BYTES)
			return { ok: false, problem: `Screenshots are at most ${IMAGE_MAX_BYTES / 1024 / 1024} MB.` };
		if (!sniffImage(input.image)) return { ok: false, problem: 'Screenshots can be PNG, JPEG, WebP or GIF.' };
	}
	return { ok: true, value: { ...input, title, description, blueprintString } };
};

export interface UploadDeps {
	db: D1Database;
	raw: R2Bucket;
	gate: UploadGate;
	/** The site's origin, for the record's URL. */
	origin: string;
	now?: number;
}

export type UploadResult =
	| { ok: true; printId: string; state: 'live' | 'processing'; suggestions: readonly Suggestion[] }
	| { ok: false; problem: string; status: 400 | 404 | 409 | 429; existing?: { printId: string; own: boolean } };

/** Refusals the gate gives, as the form says them. */
const refusal = async (db: D1Database, userId: string, outcome: GateOutcome): Promise<UploadResult | null> => {
	switch (outcome.status) {
		case 'blocked':
			return { ok: false, status: 409, problem: 'This blueprint can’t be uploaded.' };
		case 'undecodable':
			return { ok: false, status: 400, problem: 'That blueprint string can’t be read. Check it was copied whole.' };
		case 'exists': {
			// Whose is it? Any live upload source of this account's means it's theirs already.
			const ids = outcome.sources.filter((s) => s.site === 'upload' && s.goneAt === null).map((s) => printIdOf(s.siteId));
			const own =
				ids.length > 0 &&
				(await db
					.prepare(`SELECT 1 FROM uploads WHERE user_id = ? AND print_id IN (${ids.map(() => '?').join(', ')}) LIMIT 1`)
					.bind(userId, ...ids)
					.first()) !== null;
			return {
				ok: false,
				status: 409,
				problem: own ? 'You’ve already uploaded this blueprint.' : 'This blueprint is already on Blueprint Atlas.',
				existing: { printId: outcome.printId, own }
			};
		}
		default:
			return null;
	}
};

interface ImagePlan {
	id: string;
	ext: ImageExt;
	sha256: string;
	bytes: Uint8Array;
	/** The same bytes were approved already (another upload's): the record shows it at once. */
	approved: boolean;
}

/** A new image's id, type and hash, or why it can't be used. */
const planImage = async (deps: UploadDeps, bytes: Uint8Array): Promise<ImagePlan | { problem: string }> => {
	const ext = sniffImage(bytes);
	if (!ext) return { problem: 'Screenshots can be PNG, JPEG, WebP or GIF.' };
	const sha256 = await sha256Hex(bytes);
	const id = sha256.slice(0, 16);
	const known = await deps.db.prepare(`SELECT status FROM upload_images WHERE id = ?`).bind(id).first<{ status: string }>();
	if (known?.status === 'rejected' || (await deps.gate.imageBlocked(id))) return { problem: 'That screenshot can’t be used.' };
	return { id, ext, sha256, bytes, approved: known?.status === 'approved' };
};

const insertImage = (db: D1Database, image: ImagePlan, userId: string, now: number) =>
	db
		.prepare(
			`INSERT INTO upload_images (id, sha256, ext, bytes, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO NOTHING`
		)
		.bind(image.id, image.sha256, image.ext, image.bytes.byteLength, userId, now);

const putImage = async (raw: R2Bucket, image: ImagePlan) => {
	const key = imageKey(image.id, image.ext);
	if (!(await raw.head(key))) await raw.put(key, image.bytes, { httpMetadata: { contentType: IMAGE_TYPES[image.ext] } });
};

export const putRecord = (raw: R2Bucket, record: SourceRecord) =>
	raw.put(recordKey(record.siteId), toPipelineText(record), { httpMetadata: { contentType: 'application/json' } });

/** The record an upload's form makes. */
const buildRecord = (
	deps: UploadDeps,
	account: Account,
	siteId: string,
	input: UploadInput,
	/** The screenshot once approved, else null: a pending one is never in the record. */
	approvedImage: string | null,
	uploadedAt: number,
	now: number
): SourceRecord => ({
	site: 'upload',
	siteId,
	url: `${deps.origin}/prints/${printIdOf(siteId)}`,
	title: input.title,
	description: input.description || null,
	author: { site: 'upload', id: account.id, name: account.name },
	blueprintString: input.blueprintString,
	image: approvedImage ? { key: `upload.${approvedImage}`, url: '' } : null,
	uploadedAt,
	updatedAt: now,
	favorites: null,
	sourceHints: []
});

/** The UTC day (days since 1970) a time falls on: the caps count per account per UTC day. */
export const quotaDay = (now: number) => Math.floor(now / DAY_MS);

type QuotaKind = 'uploads' | 'edits';
const CAPS: Record<QuotaKind, number> = { uploads: UPLOADS_PER_DAY, edits: EDITS_PER_DAY };

/**
 * Reserves one upload or edit, and a screenshot when `image`, against today's caps in one statement, so
 * parallel requests can't pass a cap between a read and a write: null when reserved, else the cap that's
 * reached. `upload_quota` is never touched by deleting an upload, so deleting and uploading again doesn't
 * reset the caps.
 */
const reserve = async (db: D1Database, userId: string, now: number, kind: QuotaKind, image: boolean) => {
	const reserved = await db
		.prepare(
			`INSERT INTO upload_quota (user_id, day, ${kind}, images) VALUES (?1, ?2, 1, ?3)
			ON CONFLICT (user_id, day) DO UPDATE SET ${kind} = ${kind} + 1, images = images + ?3 WHERE ${kind} < ?4 AND images + ?3 <= ?5
			RETURNING ${kind}`
		)
		.bind(userId, quotaDay(now), image ? 1 : 0, CAPS[kind], IMAGES_PER_DAY)
		.first();
	if (reserved) return null;
	const used = await db
		.prepare(`SELECT ${kind} AS n FROM upload_quota WHERE user_id = ? AND day = ?`)
		.bind(userId, quotaDay(now))
		.first<{ n: number }>();
	return (used?.n ?? 0) >= CAPS[kind] ? kind : ('images' as const);
};

/** Gives back what `reserve` took, when the gate refuses: a refusal doesn't count. */
const giveBack = (db: D1Database, userId: string, now: number, kind: QuotaKind, image: boolean) =>
	db
		.prepare(`UPDATE upload_quota SET ${kind} = max(${kind} - 1, 0), images = max(images - ?3, 0) WHERE user_id = ?1 AND day = ?2`)
		.bind(userId, quotaDay(now), image ? 1 : 0)
		.run();

const capReached = (cap: QuotaKind | 'images'): UploadResult => ({
	ok: false,
	status: 429,
	problem:
		cap === 'uploads'
			? `You can upload ${UPLOADS_PER_DAY} blueprints a day. Please try again tomorrow.`
			: cap === 'edits'
				? `You can save ${EDITS_PER_DAY} edits a day. Please try again tomorrow.`
				: `You can add ${IMAGES_PER_DAY} screenshots a day. Save without one, and add it tomorrow.`
});

const DELETING: UploadResult = { ok: false, status: 409, problem: 'Your account is being deleted.' };

/** Uploads of an account waiting for the sync because they're over the Worker's cap. */
const waitingTooBig = async (db: D1Database, userId: string) =>
	(
		await db
			.prepare(`SELECT count(*) AS n FROM uploads WHERE user_id = ? AND state = 'processing' AND too_big IS NOT NULL`)
			.bind(userId)
			.first<{ n: number }>()
	)?.n ?? 0;

/** The upload's row now (after a write that may not have applied): what the owner is told. */
const stateOf = async (db: D1Database, printId: string) =>
	(await db.prepare(`SELECT state FROM uploads WHERE print_id = ?`).bind(printId).first<{ state: UploadRow['state'] }>())?.state ??
	'processing';

/** A new upload. */
export const createUpload = async (deps: UploadDeps, account: Account, raw: UploadInput): Promise<UploadResult> => {
	const now = deps.now ?? Date.now();
	if (account.deleting) return DELETING;
	const checked = checkInput(raw);
	if (!checked.ok) return { ok: false, status: 400, problem: checked.problem };
	const input = checked.value;
	let image: ImagePlan | null = null;
	if (input.image instanceof Uint8Array) {
		const planned = await planImage(deps, input.image);
		if ('problem' in planned) return { ok: false, status: 400, problem: planned.problem };
		image = planned;
	}
	const cap = await reserve(deps.db, account.id, now, 'uploads', image !== null);
	if (cap) return capReached(cap);

	const siteId = newSiteId();
	const printId = printIdOf(siteId);
	const record = buildRecord(deps, account, siteId, input, image?.approved ? image.id : null, now, now);
	const stringBytes = new TextEncoder().encode(input.blueprintString).byteLength;
	const row = (state: 'live' | 'processing', tooBig: string | null) =>
		deps.db
			.prepare(
				`INSERT INTO uploads (print_id, user_id, state, title, string_bytes, too_big, image_id, shown_name, created_at, updated_at, live_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (print_id) DO NOTHING`
			)
			.bind(
				printId,
				account.id,
				state,
				input.title,
				stringBytes,
				tooBig,
				image?.id ?? null,
				account.name,
				now,
				now,
				state === 'live' ? now : null
			);
	const imageRows = image ? [insertImage(deps.db, image, account.id, now)] : [];

	if (image) await putImage(deps.raw, image);
	await putRecord(deps.raw, record);
	// The print's rows, ours and a page-cache bump (search lists it) in one batch.
	const outcome = await deps.gate.admit(record, printId, [...imageRows, row('live', null), bumpPageVersion(deps.db, now)]);
	if (outcome.status === 'admitted') return { ok: true, printId, state: 'live', suggestions: outcome.suggestions };
	const refused = await refusal(deps.db, account.id, outcome);
	const waiting = refused === null && outcome.status === 'too-big' ? await waitingTooBig(deps.db, account.id) : 0;
	if (refused || waiting >= PROCESSING_MAX) {
		await forgetObjects(deps, recordKey(siteId), image);
		await giveBack(deps.db, account.id, now, 'uploads', image !== null);
		return (
			refused ?? {
				ok: false,
				status: 429,
				problem: `You have ${waiting} large uploads waiting to be processed. Please try again once they are on the site.`
			}
		);
	}
	// Over the Worker's cap, or the Worker couldn't finish: the next sync admits it. If the gate's batch did
	// commit before something after it failed, the row is live already and stays so.
	await deps.db.batch([...imageRows, row('processing', outcome.status === 'too-big' ? outcome.by : null)]);
	return { ok: true, printId, state: (await stateOf(deps.db, printId)) === 'live' ? 'live' : 'processing', suggestions: [] };
};

/** RAW objects of a refused upload: its record, and its image unless an upload uses it. */
const forgetObjects = async (deps: UploadDeps, key: string, image: ImagePlan | null) => {
	await deps.raw.delete(key);
	if (image && !(await deps.db.prepare(`SELECT 1 FROM upload_images WHERE id = ?`).bind(image.id).first()))
		await deps.raw.delete(imageKey(image.id, image.ext));
};

export interface UploadRow {
	print_id: string;
	user_id: string;
	state: 'processing' | 'live' | 'refused' | 'failed';
	refused_reason: string | null;
	refused_print_id: string | null;
	attempts: number;
	failure: string | null;
	shown_name: string;
	title: string;
	string_bytes: number;
	too_big: string | null;
	image_id: string | null;
	image_ext: string | null;
	image_status: 'pending' | 'approved' | 'rejected' | null;
	created_at: number;
	updated_at: number;
	live_at: number | null;
}

const ROW_SQL = `SELECT u.*, i.ext AS image_ext, i.status AS image_status FROM uploads u LEFT JOIN upload_images i ON i.id = u.image_id`;

/** The statement behind listUploads, for a caller that reads it in a batch (lib/server/admin/accounts.ts). */
export const uploadsOf = (db: D1Database, userId: string) =>
	db.prepare(`${ROW_SQL} WHERE u.user_id = ? ORDER BY u.created_at DESC`).bind(userId);

/** An account's uploads, newest first. */
export const listUploads = async (db: D1Database, userId: string) => (await uploadsOf(db, userId).all<UploadRow>()).results;

/** One upload of this account's, or null (someone else's, or none). */
export const ownUpload = (db: D1Database, userId: string, printId: string) =>
	isUploadId(printId)
		? db.prepare(`${ROW_SQL} WHERE u.print_id = ? AND u.user_id = ?`).bind(printId, userId).first<UploadRow>()
		: Promise.resolve(null);

/** The upload's record from RAW. */
export const readRecord = async (raw: R2Bucket, printId: string) => {
	const obj = await raw.get(recordKey(siteIdOf(printId)));
	return obj ? fromPipelineText(await obj.text()) : null;
};

/** An owner's edit: title, description, string and screenshot. The print keeps its URL. */
export const editUpload = async (deps: UploadDeps, account: Account, printId: string, raw: UploadInput): Promise<UploadResult> => {
	if (account.deleting) return DELETING;
	const row = await ownUpload(deps.db, account.id, printId);
	const before = row ? await readRecord(deps.raw, printId) : null;
	if (!row || !before) return { ok: false, status: 404, problem: 'No such upload.' };
	// Each edit's updated_at is new, so the 'processing' write can tell this edit gone live from the last.
	const now = Math.max(deps.now ?? Date.now(), row.updated_at + 1);
	// An empty string field keeps the current blueprint.
	const checked = checkInput({ ...raw, blueprintString: raw.blueprintString.trim() || before.blueprintString });
	if (!checked.ok) return { ok: false, status: 400, problem: checked.problem };
	const input = checked.value;

	let image: ImagePlan | null = null;
	if (input.image instanceof Uint8Array) {
		const planned = await planImage(deps, input.image);
		if ('problem' in planned) return { ok: false, status: 400, problem: planned.problem };
		image = planned;
	}
	const cap = await reserve(deps.db, account.id, now, 'edits', image !== null);
	if (cap) return capReached(cap);
	const kept = input.image === 'keep' && row.image_id && row.image_ext ? { id: row.image_id, ext: row.image_ext } : null;
	const nextImage = image ?? kept;
	const siteId = siteIdOf(printId);
	const approved = image ? (image.approved ? image.id : null) : kept && row.image_status === 'approved' ? kept.id : null;
	const record = buildRecord(deps, account, siteId, input, approved, before.uploadedAt ?? row.created_at, now);
	const stringBytes = new TextEncoder().encode(input.blueprintString).byteLength;
	const oldImage = row.image_id && row.image_id !== nextImage?.id ? { id: row.image_id, ext: row.image_ext ?? '' } : null;
	// 'processing' never overwrites this very edit gone live (the gate's batch committed before something after it failed).
	const rows = (state: 'live' | 'processing', tooBig: string | null) => [
		...(image ? [insertImage(deps.db, image, account.id, now)] : []),
		deps.db
			.prepare(
				`UPDATE uploads SET state = ?1, refused_reason = NULL, refused_print_id = NULL, attempts = 0, failure = NULL, title = ?2,
				string_bytes = ?3, too_big = ?4, image_id = ?5, shown_name = ?6, updated_at = ?7, live_at = coalesce(live_at, ?8)
				WHERE print_id = ?9 AND user_id = ?10 AND NOT (?1 = 'processing' AND state = 'live' AND updated_at = ?7)`
			)
			.bind(
				state,
				input.title,
				stringBytes,
				tooBig,
				nextImage?.id ?? null,
				account.name,
				now,
				state === 'live' ? now : null,
				printId,
				account.id
			),
		// The image it no longer uses, unless another upload does.
		...(oldImage ? [unusedImageDelete(deps.db, oldImage.id)] : [])
	];

	if (image) await putImage(deps.raw, image);
	await putRecord(deps.raw, record);
	// With a page-cache bump: the print's page and search show the edit at once.
	const outcome = await deps.gate.admit(record, printId, [...rows('live', null), bumpPageVersion(deps.db, now)]);
	const refused = outcome.status === 'admitted' ? null : await refusal(deps.db, account.id, outcome);
	if (refused) {
		// Nothing changed: the record goes back as it was.
		await putRecord(deps.raw, before);
		if (image && !(await deps.db.prepare(`SELECT 1 FROM upload_images WHERE id = ?`).bind(image.id).first()))
			await deps.raw.delete(imageKey(image.id, image.ext));
		await giveBack(deps.db, account.id, now, 'edits', image !== null);
		return refused;
	}
	if (outcome.status !== 'admitted') {
		// A live print stays as it was until the sync admits the new version.
		await deps.db.batch(rows('processing', outcome.status === 'too-big' ? outcome.by : null));
	}
	if (oldImage && !(await deps.db.prepare(`SELECT 1 FROM upload_images WHERE id = ?`).bind(oldImage.id).first()))
		await deps.raw.delete(imageKey(oldImage.id, oldImage.ext));
	return outcome.status === 'admitted'
		? { ok: true, printId, state: 'live', suggestions: outcome.suggestions }
		: { ok: true, printId, state: (await stateOf(deps.db, printId)) === 'live' ? 'live' : 'processing', suggestions: [] };
};

/** Deletes an image's row once no upload uses it (run after the upload's own row changed or went). */
const unusedImageDelete = (db: D1Database, imageId: string) =>
	db.prepare(`DELETE FROM upload_images WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM uploads WHERE image_id = ?1)`).bind(imageId);

/**
 * What goes with an upload's print: its `uploads` row, its image's row and RAW original when no other
 * upload uses it, and its RAW record. Passed to purgePrintData (`extra`, `extraKeys`) by every path
 * that deletes the print: an owner's delete through sourceGone, and a takedown (takedownPrint, for
 * `up-` prints).
 */
export const uploadPurgeExtras = async (db: D1Database, printId: string): Promise<PurgeExtras> => {
	const row = await db
		.prepare(
			`SELECT u.image_id, i.ext, (SELECT count(*) FROM uploads o WHERE o.image_id = u.image_id AND o.print_id <> u.print_id) AS shared
			FROM uploads u LEFT JOIN upload_images i ON i.id = u.image_id WHERE u.print_id = ?`
		)
		.bind(printId)
		.first<{ image_id: string | null; ext: string | null; shared: number }>();
	const image = row?.image_id && row.ext ? { id: row.image_id, ext: row.ext } : null;
	return {
		extra: (d) => [d.prepare(`DELETE FROM uploads WHERE print_id = ?`).bind(printId), ...(image ? [unusedImageDelete(d, image.id)] : [])],
		extraKeys: [recordKey(siteIdOf(printId)), ...(image && row?.shared === 0 ? [imageKey(image.id, image.ext)] : [])]
	};
};

/**
 * An owner deletes an upload. A live one's source goes through sourceGone: the print is deleted
 * (410 "deleted by its author") unless another site also has it, which keeps it. Then uploads' own
 * rows and RAW objects go, whichever it was.
 */
export const deleteUpload = async (deps: Pick<UploadDeps, 'db' | 'raw' | 'gate'>, userId: string, printId: string) => {
	const row = await ownUpload(deps.db, userId, printId);
	if (!row) return false;
	const extras = await uploadPurgeExtras(deps.db, printId);
	if (row.state === 'live' || row.live_at !== null) await deps.gate.sourceGone(siteIdOf(printId), extras);
	await deps.db.batch(extras.extra(deps.db));
	await deps.raw.delete(extras.extraKeys);
	return true;
};

/**
 * How long one request spends deleting an account's uploads. One upload's delete is about 20 subrequests
 * (D1 and R2, measured; Workers Paid allows 10,000 per request), each a round trip to the database's
 * region, so time, not the subrequest limit, is what runs out first: a far-away visitor's request does
 * fewer, and the account page asks again for the rest.
 */
export const ACCOUNT_DELETE_BUDGET_MS = 15_000;

/** How long and how many uploads one call of deleteAccountUploads may spend. */
export interface AccountDeleteOptions {
	budgetMs?: number;
	clock?: () => number;
	/** At most this many uploads tried (deleted or failed), for a caller with a bound of its own (the cron). */
	maxUploads?: number;
}

/**
 * An account's uploads, oldest first, for as long as `budgetMs` allows (and at most `maxUploads` of them),
 * before the account itself goes (users.ts deleteAccount, once none are left). One that fails is left for
 * the next call; the rest go on.
 */
export const deleteAccountUploads = async (
	deps: Pick<UploadDeps, 'db' | 'raw' | 'gate'>,
	userId: string,
	{ budgetMs = ACCOUNT_DELETE_BUDGET_MS, clock = Date.now, maxUploads = Infinity }: AccountDeleteOptions = {}
) => {
	const started = clock();
	const ids = (
		await deps.db.prepare(`SELECT print_id FROM uploads WHERE user_id = ? ORDER BY created_at`).bind(userId).all<{ print_id: string }>()
	).results;
	let deleted = 0;
	let tried = 0;
	for (const { print_id } of ids) {
		if (clock() - started >= budgetMs || tried >= maxUploads) break;
		tried++;
		try {
			if (await deleteUpload(deps, userId, print_id)) deleted++;
		} catch (e) {
			console.warn(`uploads: deleting ${print_id} with its account failed, left for the next try: ${e instanceof Error ? e.message : e}`);
		}
	}
	return { deleted, left: ids.length - deleted };
};

/**
 * One step of deleting an account, the one path for its owner (routes/account), an admin
 * (routes/admin/accounts/[id]) and the daily cron for deletions left part-way (abandoned.ts): marks it deleting (from then on it can't upload, edit or rename; a step
 * cut short leaves an account that can only go on deleting), deletes as many of its uploads as one request
 * has time for, then the account once none are left (users.ts deleteAccount). Not `done`: post again for
 * the rest (`left` is then at least 1).
 */
export const deleteAccountStep = async (deps: Pick<UploadDeps, 'db' | 'raw' | 'gate'>, userId: string, options?: AccountDeleteOptions) => {
	await markDeleting(deps.db, userId);
	const { deleted, left } = await deleteAccountUploads(deps, userId, options);
	const done = left === 0 && (await deleteAccount(deps.db, userId));
	return { deleted, left: done ? 0 : Math.max(left, 1), done };
};

/** How long the account page spends putting a new name on the account's uploads; the sync does the rest. */
export const RENAME_BUDGET_MS = 10_000;

/**
 * Puts each account's name on its uploads after a rename: the RAW record (so a later ingest keeps it), the
 * analysis document while it still credits the old name (a print handed over to another site's source
 * credits that one), then in D1 `uploads.shown_name`, `prints.author_name`, the search row's author and a
 * page-cache bump. Documents first and D1 last, so what D1 says is never ahead of what pages show; until
 * `shown_name` changes the old name stays taken (users.ts nameTaken). `userId` null: every account's
 * (the sync). Returns the uploads done and those left (out of time, or failed: the next call retries).
 */
export const refreshUploadNames = async (
	deps: { db: D1Database; raw: R2Bucket },
	userId: string | null,
	{
		budgetMs = Infinity,
		clock = Date.now,
		concurrency = 6
	}: {
		budgetMs?: number;
		clock?: () => number;
		concurrency?: number;
	} = {}
) => {
	const started = clock();
	const stale = (
		await deps.db
			.prepare(
				`SELECT u.print_id, u.shown_name AS old, a.name FROM uploads u JOIN users a ON a.id = u.user_id
				WHERE u.shown_name <> a.name AND a.deleting_at IS NULL ${userId === null ? '' : 'AND u.user_id = ?'} ORDER BY u.print_id`
			)
			.bind(...(userId === null ? [] : [userId]))
			.all<{ print_id: string; old: string; name: string }>()
	).results;
	const done: typeof stale = [];
	const one = async (u: (typeof stale)[number]) => {
		const record = await readRecord(deps.raw, u.print_id);
		if (record && record.author?.name !== u.name)
			await putRecord(deps.raw, { ...record, author: { site: 'upload', id: null, ...record.author, name: u.name } });
		const doc = await (await deps.raw.get(analysisKey(u.print_id)))?.text();
		if (doc !== undefined && (JSON.parse(doc) as { print: { author_name: string | null } }).print.author_name === u.old)
			await deps.raw.put(analysisKey(u.print_id), withAuthorName(doc, u.name), { httpMetadata: { contentType: 'application/json' } });
		done.push(u);
	};
	for (let i = 0; i < stale.length && clock() - started < budgetMs; i += concurrency) {
		await Promise.all(
			stale
				.slice(i, i + concurrency)
				.map((u) =>
					one(u).catch((e) =>
						console.warn(`uploads: renaming ${u.print_id} failed, left for the next try: ${e instanceof Error ? e.message : e}`)
					)
				)
		);
	}
	for (let i = 0; i < done.length; i += 40) {
		const part = done.slice(i, i + 40);
		await deps.db.batch([
			...part.flatMap((u) => [
				deps.db.prepare(`UPDATE uploads SET shown_name = ? WHERE print_id = ? AND shown_name = ?`).bind(u.name, u.print_id, u.old),
				deps.db
					.prepare(`UPDATE prints SET author_name = ? WHERE id = ? AND author_id IS NULL AND author_name = ?`)
					.bind(u.name, u.print_id, u.old)
			]),
			// print_id is UNINDEXED: one pass over print_search for the whole part.
			deps.db
				.prepare(
					`UPDATE print_search SET author = (SELECT author_name FROM prints WHERE id = print_search.print_id)
					WHERE print_id IN (SELECT value FROM json_each(?))`
				)
				.bind(JSON.stringify(part.map((u) => u.print_id))),
			bumpPageVersion(deps.db)
		]);
	}
	return { done: done.length, left: stale.length - done.length };
};

/**
 * Uploads waiting for the sync ('processing': over the Worker's caps, or the Worker couldn't finish),
 * oldest change first: what scripts/uploads.ts admits, and the sync's `upload` source counts.
 */
export const processingUploads = async (db: D1Database) =>
	(
		await db
			.prepare(`SELECT print_id, updated_at FROM uploads WHERE state = 'processing' ORDER BY updated_at, print_id`)
			.all<{ print_id: string; updated_at: number }>()
	).results;

export type ProcessingOutcome = 'admitted' | 'duplicate' | 'blocked' | 'undecodable' | 'failed' | 'gave-up';

/**
 * Admit one 'processing' upload, as the Worker would have (the same gate, without its caps): live, or
 * refused with the reason its owner sees on /uploads/<id> (a duplicate links the print it copies), or
 * left processing for the next sync when the gate couldn't finish ('failed'), until the
 * PROCESSING_ATTEMPTS-th failure turns it 'failed' for good ('gave-up': its owner sees why).
 */
export const admitProcessing = async (
	deps: { db: D1Database; raw: R2Bucket; gate: Pick<UploadGate, 'admit'>; now?: number },
	printId: string
): Promise<{ outcome: ProcessingOutcome; reason?: string; printId?: string }> => {
	const now = deps.now ?? Date.now();
	const refuse = async (reason: 'duplicate' | 'blocked' | 'undecodable', refusedPrintId: string | null = null) => {
		await deps.db
			.prepare(
				`UPDATE uploads SET state = 'refused', refused_reason = ?, refused_print_id = ?, too_big = NULL WHERE print_id = ? AND state = 'processing'`
			)
			.bind(reason, refusedPrintId, printId)
			.run();
		return reason;
	};
	const record = await readRecord(deps.raw, printId);
	if (!record) return { outcome: await refuse('undecodable'), reason: 'no record in RAW' };
	const live = deps.db
		.prepare(
			`UPDATE uploads SET state = 'live', refused_reason = NULL, refused_print_id = NULL, too_big = NULL, attempts = 0, failure = NULL,
			live_at = coalesce(live_at, ?) WHERE print_id = ? AND state = 'processing'`
		)
		.bind(now, printId);
	const failed = async (reason: string) => {
		const row = await deps.db
			.prepare(
				`UPDATE uploads SET attempts = attempts + 1, failure = ?1, state = CASE WHEN attempts + 1 >= ?2 THEN 'failed' ELSE state END
				WHERE print_id = ?3 AND state = 'processing' RETURNING state`
			)
			.bind(reason, PROCESSING_ATTEMPTS, printId)
			.first<{ state: string }>();
		return { outcome: row?.state === 'failed' ? ('gave-up' as const) : ('failed' as const), reason };
	};
	const outcome = await deps.gate.admit(record, printId, [live, bumpPageVersion(deps.db, now)]);
	switch (outcome.status) {
		case 'admitted':
			return { outcome: 'admitted' };
		case 'exists':
			return { outcome: await refuse('duplicate', outcome.printId), printId: outcome.printId };
		case 'blocked':
			return { outcome: await refuse('blocked') };
		case 'undecodable':
			return { outcome: await refuse('undecodable'), reason: outcome.reason };
		case 'too-big':
			return failed(`over the size cap (${outcome.by})`);
		case 'deferred':
			return failed(outcome.reason);
	}
};

/**
 * What else the sync's uploads source looks at: uploads still showing an old name (a rename the account
 * page ran out of time for: `refreshUploadNames` does them), and accounts whose deletion is still going
 * (the account page carries on when its owner comes back; the sync only counts them).
 */
export const uploadChores = async (db: D1Database) =>
	(await db
		.prepare(
			`SELECT (SELECT count(*) FROM uploads u JOIN users a ON a.id = u.user_id WHERE u.shown_name <> a.name AND a.deleting_at IS NULL) AS staleNames,
				(SELECT count(*) FROM users WHERE deleting_at IS NOT NULL) AS deletingAccounts`
		)
		.first<{ staleNames: number; deletingAccounts: number }>()) ?? { staleNames: 0, deletingAccounts: 0 };
