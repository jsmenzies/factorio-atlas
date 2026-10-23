/**
 * Where `bun run render` keeps its output (overviews, tiles, sidecars, index.json and run logs):
 * RENDERS_DIR, e.g. in .env, else data/renders in the working tree. The renderer, the uploader,
 * `render:flags`, /admin/render's start panel and the dev site's render route all read it from
 * here. The sidecars there are what tells a run a page is unchanged, so every run must see the same
 * folder; scripts/render/settings.ts's checkRendersDir stops a run that finds it empty.
 *
 * Node only: the dev site imports it lazily (dev-files.ts), so deployed Workers never load it.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** `value` (`~/` expanded, relative to `root`), or `<root>/data/<fallback>` when unset. */
const dirFrom = (root: string, value: string | undefined, fallback: string) => {
	const dir = value?.trim();
	if (!dir) return join(root, 'data', fallback);
	return resolve(root, dir === '~' || dir.startsWith('~/') ? join(homedir(), dir.slice(1)) : dir);
};

/** RENDERS_DIR (`~/` expanded, relative to `root`), or `<root>/data/renders`. */
export const rendersDir = (root = process.cwd(), value = process.env.RENDERS_DIR) => dirFrom(root, value, 'renders');

/**
 * Where `bun run render:thumbs` writes page thumbnails (`<id>/<base>.<stamp>.t<tier>.avif` and
 * `<id>/thumbs.json`), the set that is uploaded: THUMBS_DIR, else `<root>/data/thumbs`.
 */
export const thumbsDir = (root = process.cwd(), value = process.env.THUMBS_DIR) => dirFrom(root, value, 'thumbs');
