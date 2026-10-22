/**
 * Game art served as static files from the SPRITES bucket: icons now (`bun run icons`), sprite
 * atlases later. Every key sits under a content-hashed prefix (`icons/<game version>-<hash>/…`),
 * so a file never changes once uploaded and can be cached for good.
 *
 * Deployed with a sprites domain, browsers fetch straight from the bucket's custom domain
 * (`SPRITES_URL`) through Cloudflare's cache and never reach the Worker. Without one (and under
 * `bun run dev`), `/sprites/<key>` serves them from the binding, or from data/sprites on disk in
 * dev when the local bucket lacks the file.
 */
import { dev } from '$app/env';
import { env } from 'cloudflare:workers';
import { readDataFile } from './dev-files.js';

/** Keys the `/sprites` route serves: plain path segments, no `..`. */
export const SPRITE_KEY = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)+[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:webp|png|json)$/;

export const CONTENT_TYPES: Record<string, string> = { webp: 'image/webp', png: 'image/png', json: 'application/json' };

/** URL prefix of the sprite files: the bucket's custom domain, or this site's `/sprites` route. */
export const spritesBase = (): string => {
	const url = (env as Partial<Env>).SPRITES_URL?.trim();
	return url ? url.replace(/\/+$/, '') : '/sprites';
};

export interface SpriteFile {
	body: ReadableStream;
	etag?: string;
}

/** `key` must match SPRITE_KEY. */
export async function getSpriteFile(key: string): Promise<SpriteFile | null> {
	const bucket = (env as Partial<Env>).SPRITES;
	const obj = bucket ? await bucket.get(key) : null;
	if (obj) return { body: obj.body, etag: obj.httpEtag };
	return dev ? readDataFile('sprites', key) : null;
}
