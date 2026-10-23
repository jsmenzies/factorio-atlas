/**
 * Thumbnails of rendered pages (scripts/render-thumbs.ts): every page's overview scaled down at
 * its own aspect, with its transparency, so any box (search cards, book-page grids) can show it with
 * CSS `object-fit`. Kept apart from the renders (THUMBS_DIR) in the renders bucket's layout, and
 * uploaded beside them:
 *
 *   <print id>/<base>.<stamp>.t<tier>.avif   one page at one size tier (`<base>` as for the page's
 *                                           overview, `<stamp>` its overview's render stamp, so a
 *                                           redraw renames it and every URL can be cached for good)
 *   <print id>/thumbs.json                  ThumbsIndex: the pages with thumbnails, their tiers and
 *                                           overview size (so a grid reserves the space up front)
 *
 * A tier is the width of the 16:9 box a thumbnail fits in (contain): tier 320 is at most 320 × 180,
 * which is how pages are shown, so a tall page isn't made 320 px wide to be shown 100 px wide. No
 * thumbnail is larger than its overview: the first tier the overview can't fill is made at the
 * overview's own size, and larger tiers are left out (thumbTiers). In a srcset each file is
 * described by its tier (`<url> 320w`), the box width it was made for.
 *
 * Changing how thumbnails are made (THUMB) without a new name would leave old pixels in caches: bump
 * THUMB_VERSION, which is part of the name from version 2 on.
 */
import { pageBase } from './game-render.js';

/** The box thumbnails are made for: width ÷ height (Tailwind's aspect-video). */
export const THUMB_ASPECT = 16 / 9;
/** Size tiers: about 1×–3× of a 168–240 px book-page card, and 1×–3× of a phone-wide or 22rem search card. */
export const THUMB_TIERS = [320, 640, 960] as const;
export const THUMB_VERSION = 1;
/**
 * How production thumbnails are encoded (sharp; AVIF keeps the alpha channel). q80: below it dense
 * pages lose detail when zoomed, above it files grow with no visible gain. Effort 1 gives the same
 * sizes as effort 4 about six times faster.
 */
export const THUMB = { format: 'avif', quality: 80, effort: 1 } as const;
/** The per-print list of thumbnails, beside them. */
export const THUMBS_INDEX = 'thumbs.json';

export interface ThumbPage {
	/** The overview's render stamp, also in the file names. */
	stamp: string;
	/** The overview's size in pixels: the page's aspect. */
	w: number;
	h: number;
	/** Tiers made, ascending. */
	sizes: number[];
}

export interface ThumbsIndex {
	v: 1;
	/** Per page with thumbnails, by book path ("" for a single blueprint). */
	pages: Record<string, ThumbPage>;
}

/** A page's thumbnail as a page shows it: its srcset and the overview's size (for the aspect only). */
export interface PageThumb {
	srcset: string;
	w: number;
	h: number;
}

/** A thumbnail's pixel size at a tier: fits a tier × tier·9/16 box, never larger than the overview (`scale` ≤ 1). */
export const thumbSize = (w: number, h: number, tier: number) => {
	const scale = Math.min(1, tier / w, tier / THUMB_ASPECT / h);
	return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale };
};

/** The tiers made for a `w` × `h` overview: each one up to and including the first the overview can't fill. */
export const thumbTiers = (w: number, h: number, tiers: readonly number[] = THUMB_TIERS) => {
	const out: number[] = [];
	for (const t of tiers) {
		out.push(t);
		if (thumbSize(w, h, t).scale >= 1) break;
	}
	return out;
};

/** A page thumbnail's name, relative to its print. */
export const thumbFile = (path: string, stamp: string, tier: number) =>
	`${pageBase(path)}.${stamp}.t${tier}${THUMB_VERSION === 1 ? '' : `-v${THUMB_VERSION}`}.avif`;

/** A page thumbnail's name (any version), relative to its print. */
export const THUMB_FILE = /^(?:root|\d+(?:\/\d+)*)\.[0-9a-f]{10}\.t\d{3,4}(?:-v\d+)?\.avif$/;

/** `srcset` for one page's thumbnails under `base` (the print's render URL prefix), each described by its tier. */
export const thumbSrcset = (base: string, path: string, page: Pick<ThumbPage, 'stamp' | 'sizes'>) =>
	page.sizes.map((t) => `${base}/${thumbFile(path, page.stamp, t)} ${t}w`).join(', ');
