/**
 * Other sites' images as screenshots: the part a site's record builder needs (sync/codex.ts, sync/fprints.ts)
 * and the copy step (sites.ts) shares. Pure apart from hashing; for tests.
 *
 * A site's record names its image by URL. `siteImage(site, url)` turns that into the record's `image`:
 * `{ key: '<site>.<first 16 hex of the URL's SHA-256>', url }` (#lib/screenshots `siteImageId`), or null when
 * the URL isn't https on a host the site is known to keep its images on (SITE_IMAGE_HOSTS). The key becomes
 * `prints.image_id`; nothing shows until `screenshots --from-sites` has copied and sized it (never the URL).
 */
import { createHash } from 'node:crypto';
import { isSiteImage, siteImageId } from '#lib/screenshots.js';

export type ImageSite = 'codex' | 'fprints' | 'factoriobin';

/** Where each site keeps its uploaders' images: an image elsewhere is not copied (its record has none). Add a site's here. */
export const SITE_IMAGE_HOSTS: Record<ImageSite, readonly RegExp[]> = {
	// codex's own Backblaze B2 bucket (factoriocodex.s3.us-west-000.backblazeb2.com), no other.
	codex: [/^factoriocodex\.s3\.[a-z0-9-]+\.backblazeb2\.com$/],
	// fprints' own Bunny CDN zone (fprints-data.b-cdn.net), no other.
	fprints: [/^fprints-data\.b-cdn\.net$/],
	factoriobin: []
};

/**
 * At most this big; anything larger isn't a screenshot. codex has large PNGs: 28 of its images were 37–97 MB on
 * 2026-10-31, the largest 97,279,019 bytes (92.8 MiB). One of 96.6 MB (2,949 × 12,446) was sized in ≈ 9 s at
 * ≈ 550 MB peak; over CAP, so only its scaled-down full size goes up, not the original. Imgur's copy (fetch.ts)
 * has no cap of its own.
 */
export const MAX_IMAGE_BYTES = 100 * 1024 * 1024;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** The URL, if it is https on one of the site's image hosts. */
export const allowedImageUrl = (site: ImageSite, url: string | null | undefined): string | null => {
	if (!url) return null;
	let u: URL;
	try {
		u = new URL(url.trim());
	} catch {
		return null;
	}
	if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
	return SITE_IMAGE_HOSTS[site].some((h) => h.test(u.hostname)) ? u.href : null;
};

/** A record's `image` for a site's image URL, or null when it isn't one we copy. */
export const siteImage = (site: ImageSite, url: string | null | undefined): { key: string; url: string } | null => {
	const ok = allowedImageUrl(site, url);
	return ok ? { key: siteImageId(site, sha256(ok)), url: ok } : null;
};

/** The URL a print's archived pipeline record names for image `id`, checked against the id; null when it names none or another. */
export const imageUrlOf = (recordText: string, id: string): string | null => {
	if (!isSiteImage(id)) return null;
	let url: unknown;
	try {
		url = (JSON.parse(recordText) as { source?: { image?: { url?: unknown } | null } }).source?.image?.url;
	} catch {
		return null;
	}
	if (typeof url !== 'string') return null;
	const site = id.slice(0, id.indexOf('.')) as ImageSite;
	return siteImage(site, url)?.key === id ? url : null;
};
