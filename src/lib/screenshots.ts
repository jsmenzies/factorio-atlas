/**
 * Our copies of the prints' Imgur screenshots (`bun run screenshots`), in the SCREENSHOTS bucket:
 * the original file, sizes made from it, and a small manifest per image. Pure: the file names, the
 * sizes, and which picture a search card, print header or link preview shows. Shared by the site
 * and the scripts.
 *
 * Keys, by image id: an Imgur id, or `upload.<16 hex>` for an approved upload's screenshot (the first 16
 * hex digits of its SHA-256; the original stays private in RAW, the screenshots step copies it from
 * there), or `<site>.<16 hex>` for another site's image (of its URL's SHA-256, copied from that URL by
 * `--from-sites`). Either way an id's bytes never change: a new screenshot is a new id.
 *
 *   <id>.<ext>                    the original, untouched (jpg | png | gif | webp)
 *   <id>.v<V>.full.<jpg|webp>     instead of the original when it is over CAP (JPEG stays JPEG, PNG becomes lossless WebP)
 *   <id>.v<V>.c<tier>.avif        16:9 centre crops for cards and the print header (tiers 320/640/960, never enlarged)
 *   <id>.v<V>.l.avif              "large", for the lightbox: fits LARGE_MAX
 *   <id>.v<V>.og.jpg              the link preview: fits OG_MAX
 *   <id>.json                     ShotManifest: whether the copy is there, and the original's format and size
 *
 * <V> is SCREENSHOT_VERSION when the sizes were made, recorded in the manifest and the `screenshots`
 * table (migration 0019), so a page always names files that exist. Changing how sizes are made
 * means bumping it: every name is immutable.
 */
import { imgurUrl } from './format.js';
import { thumbFile, thumbTiers, thumbSize, THUMB_ASPECT } from './viewer/thumbs.js';

export const SCREENSHOT_VERSION = 1;
/** Card and header crop widths (as the render thumbnails' tiers). */
export const SHOT_TIERS = [320, 640, 960] as const;
export const LARGE_MAX = 2560;
export const OG_MAX = 1200;
/** Originals over either limit are scaled down to fit both (3840 × 2160 is 8.3 MP). */
export const CAP = { pixels: 3840 * 2160, side: 8192 } as const;

/**
 * An Imgur image id: those seen in the mirror are 7 or 8 letters and digits. Anything else in a record's
 * `image.id` that isn't one of our own images (isOwnImage), e.g. the 20-character id of
 * `-P3dZ4tkk0JMjk6H-Zon`, is no Imgur image: the screenshots step never copies it and no page hotlinks Imgur
 * for it (Imgur answers such a URL with its home page).
 */
export const IMGUR_ID = /^[A-Za-z0-9]{5,10}$/;
export const isImgurId = (id: string) => IMGUR_ID.test(id);

/** An approved upload's screenshot: `upload.` and the first 16 hex digits of the image's SHA-256 (migration 0024). */
export const UPLOAD_IMAGE = /^upload\.[0-9a-f]{16}$/;
export const isUploadImage = (id: string) => UPLOAD_IMAGE.test(id);
/** The image id of an upload image (`upload_images.id`, 16 hex). */
export const uploadImageId = (hex: string) => `upload.${hex}`;

/**
 * Another site's image, named in its record (codex's `image_url`): `<site>.` and the first 16 hex digits of
 * the SHA-256 of its URL. Copied by `bun run screenshots --from-sites S` (scripts/screenshots/sites.ts); never
 * hotlinked, and never on Imgur.
 */
export const SITE_IMAGE = /^(?:codex|fprints|factoriobin)\.[0-9a-f]{16}$/;
export const isSiteImage = (id: string) => SITE_IMAGE.test(id);
/** The image id of a site's image URL, from the URL's SHA-256 (hex). */
export const siteImageId = (site: 'codex' | 'fprints' | 'factoriobin', urlSha256: string) => `${site}.${urlSha256.slice(0, 16)}`;

/** Only our own copies ever show: an upload's image or another site's, never looked up on Imgur. */
export const isOwnImage = (id: string) => isUploadImage(id) || isSiteImage(id);

/** copied: the files are in the bucket; dead: gone from Imgur before we copied it; removed: taken down on request. */
export type ShotState = 'copied' | 'dead' | 'removed';

/** An image whose copy is in the bucket: its Imgur id, the version its sizes were made with, the original's extension and size. */
export interface Shot {
	id: string;
	v: number;
	ext: string;
	w: number;
	h: number;
}

/** `<id>.json` in the bucket. `state` alone for dead and removed images. */
export type ShotManifest = { state: 'copied'; v: number; ext: string; w: number; h: number } | { state: 'dead' | 'removed' };

export const manifestKey = (id: string) => `${id}.json`;

export interface ShotFile {
	key: string;
	width: number;
	height: number;
}

/** The largest 16:9 region of a w × h image (what a card's `object-cover` shows). */
export const cropBox = (w: number, h: number) =>
	w / h > THUMB_ASPECT
		? { width: Math.max(1, Math.round(h * THUMB_ASPECT)), height: h }
		: { width: w, height: Math.max(1, Math.round(w / THUMB_ASPECT)) };

/** Fits w × h inside max × max, never enlarged. */
export const fitInside = (w: number, h: number, max: number) => {
	const s = Math.min(1, max / w, max / h);
	return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
};

export const overCap = (w: number, h: number) => w * h > CAP.pixels || Math.max(w, h) > CAP.side;

/** The size an over-cap original is scaled to. */
export const capSize = (w: number, h: number) => {
	const s = Math.min(1, Math.sqrt(CAP.pixels / (w * h)), CAP.side / Math.max(w, h));
	return { width: Math.max(1, Math.floor(w * s)), height: Math.max(1, Math.floor(h * s)) };
};

/** Extension of the scaled-down full size: JPEG stays JPEG, everything else becomes lossless WebP. GIFs are never scaled (animation). */
export const fullExt = (ext: string) => (ext === 'jpg' ? 'jpg' : 'webp');
const capped = (s: Shot) => s.ext !== 'gif' && overCap(s.w, s.h);

/** Every file of a copied image (not its manifest), with the pixel size each is made at. */
export function shotFiles(s: Shot) {
	const base = `${s.id}.v${s.v}`;
	const box = cropBox(s.w, s.h);
	const crops = thumbTiers(box.width, box.height, SHOT_TIERS).map((tier) => {
		const { width, height } = thumbSize(box.width, box.height, tier);
		return { tier, key: `${base}.c${tier}.avif`, width, height };
	});
	const full = capped(s)
		? { key: `${base}.full.${fullExt(s.ext)}`, ...capSize(s.w, s.h) }
		: { key: `${s.id}.${s.ext}`, width: s.w, height: s.h };
	return {
		crops,
		large: { key: `${base}.l.avif`, ...fitInside(s.w, s.h, LARGE_MAX) } as ShotFile,
		og: { key: `${base}.og.jpg`, ...fitInside(s.w, s.h, OG_MAX) } as ShotFile,
		full: { ...full, capped: capped(s) }
	};
}

export const shotKeys = (s: Shot) => {
	const f = shotFiles(s);
	return [...f.crops.map((c) => c.key), f.large.key, f.og.key, f.full.key];
};

/** Keys the `/screenshots` route serves. */
export const SHOT_KEY =
	/^(?:[A-Za-z0-9]{5,10}|upload\.[0-9a-f]{16}|(?:codex|fprints|factoriobin)\.[0-9a-f]{16})(?:\.v\d+\.(?:c\d{3,4}\.avif|l\.avif|og\.jpg|full\.(?:jpg|webp))|\.(?:jpg|png|gif|webp|json))$/;

export const SHOT_CONTENT_TYPES: Record<string, string> = {
	avif: 'image/avif',
	jpg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	webp: 'image/webp',
	json: 'application/json'
};

/** A picture to show: `src` (and a `srcset` of widths), with its intrinsic size for `width`/`height`. */
export interface Picture {
	src: string;
	srcset?: string;
	width: number;
	height: number;
}

/** The crops as one picture (the smallest as `src`). */
export const cropPicture = (base: string, s: Shot): Picture => {
	const { crops } = shotFiles(s);
	return {
		src: `${base}/${crops[0].key}`,
		srcset: crops.map((c) => `${base}/${c.key} ${c.tier}w`).join(', '),
		width: crops[0].width,
		height: crops[0].height
	};
};

/** The largest crop (960 wide at most): the print header's backdrop. */
export const backdropPicture = (base: string, s: Shot): Picture => {
	const c = shotFiles(s).crops.at(-1)!;
	return { src: `${base}/${c.key}`, width: c.width, height: c.height };
};

export const filePicture = (base: string, f: ShotFile): Picture => ({ src: `${base}/${f.key}`, width: f.width, height: f.height });

/** A search card's columns this needs (queries.ts CARD): the screenshot row (migration 0019) and the render cover (0018). */
export interface CardImageColumns {
	id: string;
	image_id: string | null;
	image_type: string | null;
	/** 'copied', 'dead' or 'removed'; null: no row, the image's state is unknown (not copied yet). */
	shot_state: string | null;
	shot_v: number | null;
	shot_ext: string | null;
	shot_w: number | null;
	shot_h: number | null;
	cover_page: string | null;
	cover_stamp: string | null;
	cover_w: number | null;
	cover_h: number | null;
}

/** `imgur`: hotlinked from Imgur, so the `<img>` needs `referrerpolicy="no-referrer"`. */
export type CardImage = Picture & { kind: 'screenshot' | 'render' | 'imgur' };

/** The copied screenshot named by a card's or manifest's columns, or null. */
export const shotOf = (
	id: string | null,
	state: string | null,
	v: number | null,
	ext: string | null,
	w: number | null,
	h: number | null
): Shot | null => (id && state === 'copied' && v && ext && w && h ? { id, v, ext, w, h } : null);

/** Imgur's copies have no size we know: these stand in for `width`/`height` (the box shows them 16:9 anyway). */
const IMGUR_CARD = { width: 640, height: 360 };
const IMGUR_BACKDROP = { width: 1024, height: 576 };

/**
 * What a search card shows, by the state of the author's screenshot (`renderBase` is the print's
 * render URL prefix, renders.ts):
 *
 * - copied: our 16:9 crops;
 * - dead (gone from Imgur before we copied it) or removed (taken down on request): the
 *   cover page's render thumbnail, else nothing; never Imgur;
 * - unknown (no row: not copied yet): Imgur's 640 px copy as before, else the render thumbnail, else nothing;
 *   an upload's or another site's image (`upload.…`, `codex.…`) is never on Imgur, so until the screenshots
 *   step has sized it the card shows the render thumbnail, else nothing; so does an id that is no Imgur id
 *   (IMGUR_ID), which never gets a row.
 */
export function cardImage(c: CardImageColumns, bases: { shots: string; renderBase: (id: string) => string }): CardImage | null {
	const shot = shotOf(c.image_id, c.shot_state, c.shot_v, c.shot_ext, c.shot_w, c.shot_h);
	if (shot) return { kind: 'screenshot', ...cropPicture(bases.shots, shot) };
	// Own images (isOwnImage) and ids Imgur never had (IMGUR_ID) fail isImgurId: the render thumbnail, else nothing.
	if (c.shot_state === null && c.image_id && isImgurId(c.image_id))
		return { kind: 'imgur', src: imgurUrl(c.image_id, c.image_type, 'large'), ...IMGUR_CARD };
	if (c.cover_page !== null && c.cover_stamp && c.cover_w && c.cover_h) {
		const base = bases.renderBase(c.id);
		const tiers = thumbTiers(c.cover_w, c.cover_h);
		const first = thumbSize(c.cover_w, c.cover_h, tiers[0]);
		return {
			kind: 'render',
			src: `${base}/${thumbFile(c.cover_page, c.cover_stamp, tiers[0])}`,
			srcset: tiers.map((t) => `${base}/${thumbFile(c.cover_page!, c.cover_stamp!, t)} ${t}w`).join(', '),
			width: first.width,
			height: first.height
		};
	}
	return null;
}

/** The print and render pages' view of a print's screenshot, from its manifest. */
export interface ShotView {
	/**
	 * 'unknown': no manifest (not copied yet), or the print has no screenshot. 'preparing': an upload's approved
	 * screenshot, or another site's image, that the screenshots step hasn't sized yet (no manifest): nothing to
	 * show until it has.
	 */
	state: ShotState | 'unknown' | 'preparing';
	/** The pictures come from Imgur (state unknown): their `<img>` needs `referrerpolicy="no-referrer"`. */
	imgur: boolean;
	backdrop: Picture | null;
	large: Picture | null;
	/**
	 * The whole screenshot at a modest size, shown inline (the About and Overview tabs): our link
	 * preview JPEG (fits 1200 px), or Imgur's 640 px copy with a stand-in size while unknown.
	 */
	inline: Picture | null;
	/** The original (or its scaled-down full size): "View original". A size of 0 × 0 is unknown (Imgur's). */
	full: (Picture & { capped: boolean }) | null;
	/** The link preview: ours; Imgur's 1024 px copy while the state is unknown; else none (the site's card). */
	og: Picture | null;
}

/** Why a print with a screenshot shows none, by its state (else "Screenshot unavailable"). */
export const NO_SHOT: Partial<Record<ShotView['state'], string>> = {
	removed: 'Screenshot removed',
	preparing: 'Screenshot coming soon'
};

/**
 * Header backdrop, lightbox and link preview by the same rules as cardImage: ours when copied;
 * Imgur's copies while unknown (as before the copies existed); nothing from Imgur once the image is
 * known to be dead or removed.
 */
export function shotView(imageId: string | null, imageType: string | null, manifest: ShotManifest | null, base: string): ShotView {
	const shot = manifest?.state === 'copied' && imageId ? shotOf(imageId, 'copied', manifest.v, manifest.ext, manifest.w, manifest.h) : null;
	if (shot) {
		const f = shotFiles(shot);
		return {
			state: 'copied',
			imgur: false,
			backdrop: backdropPicture(base, shot),
			large: filePicture(base, f.large),
			inline: filePicture(base, f.og),
			full: { ...filePicture(base, f.full), capped: f.full.capped },
			og: filePicture(base, f.og)
		};
	}
	const none = { imgur: false, backdrop: null, large: null, inline: null, full: null, og: null };
	if (manifest && manifest.state !== 'copied') return { state: manifest.state, ...none };
	if (!imageId) return { state: 'unknown', ...none };
	// Never Imgur for an upload's or another site's image: only our sized copies, once they exist.
	if (isOwnImage(imageId)) return { state: 'preparing', ...none };
	// Nor for an id Imgur never had: no copy can exist either, so shown as unavailable.
	if (!isImgurId(imageId)) return { state: 'unknown', ...none };
	const original = imgurUrl(imageId, imageType, 'original');
	const preview = imgurUrl(imageId, imageType, 'preview');
	return {
		state: 'unknown',
		imgur: true,
		backdrop: { src: preview, ...IMGUR_BACKDROP },
		large: { src: original, width: 0, height: 0 },
		inline: { src: imgurUrl(imageId, imageType, 'large'), ...IMGUR_CARD },
		full: { src: original, width: 0, height: 0, capped: false },
		og: { src: preview, width: 0, height: 0 }
	};
}

/** A manifest as read from the bucket, or null when it isn't one. */
export function parseManifest(json: unknown): ShotManifest | null {
	const m = json as Partial<{ state: string; v: number; ext: string; w: number; h: number }> | null;
	if (m?.state === 'dead' || m?.state === 'removed') return { state: m.state };
	if (
		m?.state === 'copied' &&
		Number.isInteger(m.v) &&
		typeof m.ext === 'string' &&
		/^(?:jpg|png|gif|webp)$/.test(m.ext) &&
		m.w! > 0 &&
		m.h! > 0
	)
		return { state: 'copied', v: m.v!, ext: m.ext, w: m.w!, h: m.h! };
	return null;
}
