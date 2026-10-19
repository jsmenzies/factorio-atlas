/**
 * Game-look render files (scripts/render-game.ts): the RENDERS bucket, or data/renders on
 * disk in dev when the bucket lacks the file (the dev server's platform proxy only picks up
 * new bindings on restart).
 */
import { dev } from '$app/env';
import { env } from 'cloudflare:workers';
import type { RenderSidecar } from '#lib/viewer/game-render.js';

export interface RenderFile {
	body: ReadableStream;
	etag?: string;
}

const fromDisk = async (key: string): Promise<RenderFile | null> => {
	const { readFile } = await import('node:fs/promises');
	const { join, normalize } = await import('node:path');
	const root = join(process.cwd(), 'data', 'renders');
	const path = normalize(join(root, key));
	if (!path.startsWith(root)) return null;
	try {
		return { body: new Blob([new Uint8Array(await readFile(path))]).stream() };
	} catch {
		return null;
	}
};

/** `key` is `<print id>/<file>`; callers check `<file>` against RENDER_FILE first. */
export async function getRenderFile(key: string): Promise<RenderFile | null> {
	const bucket = (env as Partial<Env>).RENDERS;
	const obj = bucket ? await bucket.get(key) : null;
	if (obj) return { body: obj.body, etag: obj.httpEtag };
	return dev ? fromDisk(key) : null;
}

async function getJson<T>(key: string): Promise<T | null> {
	const file = await getRenderFile(key);
	if (!file) return null;
	try {
		return (await new Response(file.body).json()) as T;
	} catch {
		return null;
	}
}

export const getRenderSidecar = (id: string, base: string) => getJson<RenderSidecar>(`${id}/${base}.json`);
