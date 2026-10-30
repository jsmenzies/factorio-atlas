/**
 * /admin/add in the Worker (deployed): a factoriobin post added through the gate within the Worker's caps
 * (WORKER_LIMITS); over them the page says to add it from the local admin page (`bun run add`, no caps).
 * The post's two responses are kept ten minutes in this data centre's Cache API, so a look-up followed by
 * an add reads factoriobin once.
 */
import { summaryOf, type AddView } from '#lib/add-by-link.js';
import { WORKER_LIMITS } from '../pipeline/admit.js';
import { addFactoriobinPost, type Fetcher } from '../pipeline/factoriobin.js';

const CACHE_S = 600;

/** fetch through `caches.default` (no cache under Node or Bun: plain fetch). */
export const cachedFetch: Fetcher = async (url, init) => {
	const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
	const key = new Request(url);
	const hit = await cache?.match(key).catch(() => undefined);
	if (hit) return hit;
	const res = await fetch(url, init);
	if (!cache || res.status !== 200) return res;
	const copy = new Response(res.body, res);
	copy.headers.set('cache-control', `max-age=${CACHE_S}`);
	await cache.put(key, copy.clone()).catch(() => undefined);
	return copy;
};

export async function addInWorker(env: { DB: D1Database; RAW: R2Bucket }, link: string, plan: boolean): Promise<AddView> {
	const r = await addFactoriobinPost(env, link, { fetch: cachedFetch, limits: WORKER_LIMITS, plan });
	return { ...r, stage: null, link, stored: null, summary: summaryOf(r) };
}
