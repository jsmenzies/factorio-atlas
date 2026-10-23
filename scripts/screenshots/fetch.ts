/**
 * One request to i.imgur.com: our user agent, no Referer, redirects not followed (a 302 to
 * removed.png is how Imgur says an image is gone), a timeout, and the body read only for a 200.
 */
import { TIMEOUT_MS, USER_AGENT } from './args.js';
import type { Reply } from './classify.js';

export const imgurOriginal = (id: string, ext: string) => `https://i.imgur.com/${encodeURIComponent(id)}.${ext}`;

export async function fetchImgur(url: string, signal: AbortSignal): Promise<Reply> {
	const res = await fetch(url, {
		redirect: 'manual',
		referrerPolicy: 'no-referrer',
		headers: { 'user-agent': USER_AGENT },
		signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
	});
	const body = res.status === 200 ? new Uint8Array(await res.arrayBuffer()) : null;
	if (res.status !== 200) await res.body?.cancel();
	return {
		status: res.status,
		location: res.headers.get('location'),
		contentType: res.headers.get('content-type'),
		etag: res.headers.get('etag'),
		body
	};
}
