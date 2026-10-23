/**
 * Our copies of the authors' screenshots, from the SCREENSHOTS bucket (`bun run screenshots
 * --upload`; names and sizes in #lib/screenshots.ts). Deployed with a screenshots domain, browsers
 * fetch them straight from the bucket's custom domain (`SCREENSHOTS_URL`) through Cloudflare's
 * cache; without one (and under `bun run dev`), `/screenshots/<key>` serves them from the binding.
 *
 * The print and render pages learn whether a print's screenshot is copied from its manifest
 * (`<imgur id>.json`), as they read only R2; search cards from the `screenshots` table (migration
 * 0019).
 */
import { env } from 'cloudflare:workers';
import { manifestKey, parseManifest, shotView, type ShotManifest, type ShotView } from '#lib/screenshots.js';

/** URL prefix of the screenshot files: the bucket's custom domain, or this site's `/screenshots` route. */
export const screenshotsBase = (): string => {
	const url = (env as Partial<Env>).SCREENSHOTS_URL?.trim();
	return url ? url.replace(/\/+$/, '') : '/screenshots';
};

export interface ShotFileBody {
	body: ReadableStream;
	etag?: string;
}

/** `key` must match SHOT_KEY. */
export async function getShotFile(key: string): Promise<ShotFileBody | null> {
	const bucket = (env as Partial<Env>).SCREENSHOTS;
	const obj = bucket ? await bucket.get(key) : null;
	return obj ? { body: obj.body, etag: obj.httpEtag } : null;
}

/**
 * The image's manifest, or null when there is none (not copied yet) or it can't be read: a failed
 * read only means the page shows what it would without a copy.
 */
export async function getShotManifest(imageId: string | null): Promise<ShotManifest | null> {
	if (!imageId) return null;
	try {
		const file = await getShotFile(manifestKey(imageId));
		return file ? parseManifest(await new Response(file.body).json()) : null;
	} catch (e) {
		console.warn(`screenshot manifest ${imageId}: ${e instanceof Error ? e.message : String(e)}`);
		return null;
	}
}

/** What the print and render pages show of a print's screenshot (#lib/screenshots.ts shotView). */
export const loadShotView = async (print: { image_id: string | null; image_type: string | null }): Promise<ShotView> =>
	shotView(print.image_id, print.image_type, await getShotManifest(print.image_id), screenshotsBase());
