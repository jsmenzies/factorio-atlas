/**
 * Files on disk, for `vite dev`: the render and sprite routes fall back to what `bun run render`
 * (RENDERS_DIR, else data/renders), `bun run render:thumbs` (THUMBS_DIR, else data/thumbs) and
 * `bun run icons` (data/sprites) wrote. Node built-ins are
 * imported lazily, so deployed Workers never load them.
 */

/** The file at `<renders dir, thumbs dir or data/sprites>/<key>`, or null when it's missing or the key would leave that folder. */
export const readDataFile = async (dir: 'renders' | 'thumbs' | 'sprites', key: string): Promise<{ body: ReadableStream } | null> => {
	const { readFile } = await import('node:fs/promises');
	const { join, normalize, sep } = await import('node:path');
	const dirs = await import('./renders-dir.js');
	const root = dir === 'renders' ? dirs.rendersDir() : dir === 'thumbs' ? dirs.thumbsDir() : join(process.cwd(), 'data', dir);
	const path = normalize(join(root, key));
	if (!path.startsWith(root + sep)) return null;
	try {
		return { body: new Blob([new Uint8Array(await readFile(path))]).stream() };
	} catch {
		return null;
	}
};
