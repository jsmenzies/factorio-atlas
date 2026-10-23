/**
 * What one answer from i.imgur.com means for the run. Pure, for tests.
 *
 * Measured 2026-10-23: an original answers 200 with its stored format's Content-Type (whatever
 * extension was asked for) and an ETag that is the MD5 of the body; a removed or unknown id answers
 * 302 to `https://i.imgur.com/removed.png`; a refused client gets 429 (e.g. a generic user agent)
 * or 403 (e.g. a Referer Imgur blocks). Some regions get a placeholder image as a normal 200, which
 * the runner's canary and duplicate guard catch.
 */
import { EXT, imageSize, kindOfMime, md5 as md5Of, sniff, type ImageKind } from './image.js';

/** MD5 of `https://i.imgur.com/removed.png` (161 × 81, 503 bytes). */
export const REMOVED_MD5 = 'd835884373f4d6c8f24742ceabe74946';

export interface Reply {
	status: number;
	location: string | null;
	contentType: string | null;
	etag: string | null;
	/** Only read for a 200. */
	body: Uint8Array | null;
}

export type Outcome =
	| { kind: 'ok'; type: ImageKind; ext: string; md5: string; bytes: number; width: number | null; height: number | null }
	/** Gone from Imgur: recorded, and not asked again unless `--recheck-dead`. */
	| { kind: 'dead'; reason: string }
	/** Worth another attempt (5xx, timeouts, a body that doesn't match its ETag). */
	| { kind: 'retry'; reason: string }
	/** Not this image, this run: recorded as failed and tried again on the next run. */
	| { kind: 'failed'; reason: string }
	/** Imgur is refusing us, or serving something that isn't the image: the whole run stops. */
	| { kind: 'stop'; reason: string };

/** `"abc…"` or `W/"abc…"` → `abc…` when it looks like an MD5, else null. */
export const etagMd5 = (etag: string | null) => {
	const v = etag
		?.trim()
		.replace(/^W\//, '')
		.replace(/^"(.*)"$/, '$1')
		.toLowerCase();
	return v && /^[0-9a-f]{32}$/.test(v) ? v : null;
};

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function classify(r: Reply, md5: (b: Uint8Array) => string = md5Of): Outcome {
	if (r.status === 200) {
		if (!r.body || r.body.length === 0) return { kind: 'retry', reason: 'empty body' };
		const sum = md5(r.body);
		if (sum === REMOVED_MD5) return { kind: 'dead', reason: 'removed.png served' };
		const said = kindOfMime(r.contentType);
		if (!said) {
			if (r.contentType?.toLowerCase().startsWith('text/')) return { kind: 'stop', reason: `served ${r.contentType} instead of an image` };
			return { kind: 'failed', reason: `content-type ${r.contentType ?? 'missing'}` };
		}
		const is = sniff(r.body);
		if (!is) return { kind: 'failed', reason: `bytes are no known image format (content-type ${said})` };
		if (is !== said) return { kind: 'failed', reason: `content-type says ${said}, bytes are ${is}` };
		const tag = etagMd5(r.etag);
		if (!tag) return { kind: 'failed', reason: `no MD5 ETag to check the body against (${r.etag ?? 'none'})` };
		if (tag !== sum) return { kind: 'retry', reason: 'body MD5 differs from the ETag (cut short?)' };
		const size = imageSize(r.body, is);
		return { kind: 'ok', type: is, ext: EXT[is], md5: sum, bytes: r.body.length, width: size?.width ?? null, height: size?.height ?? null };
	}
	if (REDIRECTS.has(r.status)) {
		if (r.location && /\/removed\.png(?:[?#].*)?$/.test(r.location)) return { kind: 'dead', reason: 'redirect to removed.png' };
		return { kind: 'failed', reason: `HTTP ${r.status} to ${r.location ?? 'nowhere'}` };
	}
	if (r.status === 404 || r.status === 410) return { kind: 'dead', reason: `HTTP ${r.status}` };
	if (r.status === 429) return { kind: 'stop', reason: 'HTTP 429: Imgur is limiting or refusing this client' };
	if (r.status === 403) return { kind: 'stop', reason: 'HTTP 403: Imgur is refusing this client (user agent, Referer or address)' };
	if (r.status === 408 || r.status >= 500) return { kind: 'retry', reason: `HTTP ${r.status}` };
	return { kind: 'failed', reason: `HTTP ${r.status}` };
}
