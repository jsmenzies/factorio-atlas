/**
 * What an Imgur original really is: its format from the first bytes (Imgur's Content-Type and our
 * records' `image.type` can disagree with them), its pixel size from the header (#lib/image-header.ts),
 * and its MD5 (which Imgur's ETag on originals is). Pure, for tests.
 */
import { createHash } from 'node:crypto';
import type { ImageKind } from '#lib/image-header.js';

export { imageSize, sniff, type ImageKind } from '#lib/image-header.js';

/** File extension we store each kind under. */
export const EXT: Record<ImageKind, string> = { jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp' };

export const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex');

/** `image/jpeg; …` → 'jpeg'; null for anything that isn't one of the four. */
export const kindOfMime = (mime: string | null | undefined): ImageKind | null => {
	const t = mime?.split(';')[0]?.trim().toLowerCase();
	if (t === 'image/jpeg' || t === 'image/jpg' || t === 'image/pjpeg') return 'jpeg';
	if (t === 'image/png') return 'png';
	if (t === 'image/gif') return 'gif';
	if (t === 'image/webp') return 'webp';
	return null;
};

/** The extension to ask Imgur for, from a record's `image.type` (Imgur ignores it, but a bare id redirects to its page). */
export const requestExt = (labelled: string | null | undefined) => EXT[kindOfMime(labelled) ?? 'jpeg'];
