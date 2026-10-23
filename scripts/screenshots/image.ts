/**
 * What an Imgur original really is: its format from the first bytes (Imgur's Content-Type and our
 * records' `image.type` can disagree with them), its pixel size from the header, and its MD5 (which
 * Imgur's ETag on originals is). Pure, for tests.
 */
import { createHash } from 'node:crypto';

export type ImageKind = 'jpeg' | 'png' | 'gif' | 'webp';

/** File extension we store each kind under. */
export const EXT: Record<ImageKind, string> = { jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp' };

export const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex');

const startsWith = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** The format the bytes are in, or null when they're none of the four. */
export const sniff = (b: Uint8Array): ImageKind | null => {
	if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpeg';
	if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
	if (startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a'))) return 'gif';
	if (startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8)) return 'webp';
	return null;
};

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

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];

/** JPEG start-of-frame markers (C4 DHT, C8 JPG and CC DAC are not frames). */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

const jpegSize = (b: Uint8Array) => {
	let i = 2;
	while (i + 4 <= b.length) {
		if (b[i] !== 0xff) return null;
		const marker = b[i + 1];
		if (marker === 0xff) {
			i++; // fill byte
			continue;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			i += 2;
			continue;
		}
		if (SOF.has(marker)) return i + 9 <= b.length ? { width: u16be(b, i + 7), height: u16be(b, i + 5) } : null;
		i += 2 + u16be(b, i + 2);
	}
	return null;
};

const webpSize = (b: Uint8Array) => {
	if (b.length < 30) return null;
	const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
	if (chunk === 'VP8X') return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
	if (chunk === 'VP8 ') return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
	if (chunk === 'VP8L') {
		const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
		return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
	}
	return null;
};

/** Pixel size from the header (a GIF's logical screen), or null when it can't be read. */
export const imageSize = (b: Uint8Array, kind: ImageKind): { width: number; height: number } | null => {
	if (kind === 'png') return b.length >= 24 ? { width: u32be(b, 16), height: u32be(b, 20) } : null;
	if (kind === 'gif') return b.length >= 10 ? { width: u16le(b, 6), height: u16le(b, 8) } : null;
	if (kind === 'webp') return webpSize(b);
	return jpegSize(b);
};
