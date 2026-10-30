/**
 * factoriobin.com post links: what a link someone shared names. Browser-safe (the admin page checks a
 * link as it is typed; the dev plugin before it runs a command).
 */
import { siteUrl } from './sources';

/** A post id: letters and digits (6 on old posts, 8 now). */
const POST_ID = /^[A-Za-z0-9]{4,16}$/;

export interface PostLink {
	readonly id: string;
	/** The book node the link named (`/post/<id>/<n>`), else null; the whole post is added either way. */
	readonly node: number | null;
}

/**
 * The post a link names: `https://factoriobin.com/post/<id>[/<n>][/info.json|/blueprint.txt]`, with or
 * without the scheme or `www.`, or a bare id. Null for anything else.
 */
export function parsePostLink(input: string): PostLink | null {
	const text = input.trim();
	if (POST_ID.test(text)) return { id: text, node: null };
	let url: URL;
	try {
		url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	if (url.hostname !== 'factoriobin.com' && url.hostname !== 'www.factoriobin.com') return null;
	const m = /^\/post\/([A-Za-z0-9]+)(?:\/(\d{1,6}))?(?:\/(?:info\.json|blueprint\.txt))?\/?$/.exec(url.pathname);
	if (!m || !POST_ID.test(m[1])) return null;
	return { id: m[1], node: m[2] === undefined ? null : Number(m[2]) };
}

/** A post's page (sources.ts, the one site table). */
export const postUrl = (id: string) => siteUrl('factoriobin', id)!;
