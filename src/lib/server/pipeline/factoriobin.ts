/**
 * factoriobin.com posts, added one at a time from a link someone shared (it has no listing, search or
 * feed, and we never enumerate its ids). Its documented "Simple API":
 *
 *   https://factoriobin.com/post/<id>/info.json   { post, node }: the post and its root node
 *   node.blueprintStringUrl                         the exchange string on its CDN (a random path, so
 *                                                   only from info.json); null while still processing
 *
 * Polite by design: one request for info.json and one for the string, with a User-Agent naming us; the
 * caller's `fetch` may cache (posts don't change). A link to a book page (`/post/<id>/<n>`) adds the whole
 * post: the root node is the print.
 *
 * The record (SourceRecord): site 'factoriobin', print id `fbin-<id>`, title the post's (else the
 * blueprint's label), description the blueprint's own in-game one, author whoever the post names
 * (`postedBy.username`; most posts are anonymous, and the poster isn't always the author), uploadedAt the
 * post's `createdAt`. No image: factoriobin has no player screenshots, only its own render JPG per
 * blueprint (none for a book), and our render and thumbnail stand in for it, so nothing is copied or
 * linked from its CDN.
 *
 * Works in the Worker and in Bun.
 */
import { parsePostLink, postUrl, type PostLink } from '#lib/factoriobin-link.js';
import type { AdmitLimits } from './admit';
import { addRecord, knownSource, type AddBindings, type AddResult } from './add-record';
import type { SourceRecord } from './source-record';

const CDN = 'https://cdn.factoriobin.com/';
export const FACTORIOBIN_USER_AGENT = 'BlueprintAtlas/1.0 (+https://github.com/jsmenzies/factorio-atlas; adds posts shared by link)';

/** Bun's ceiling on a string (no Worker cap): far past any print in the mirror (9.9 MB). */
const MAX_STRING_BYTES = 64 * 1024 * 1024;

export const infoUrl = (id: string) => `${postUrl(id)}/info.json`;

/** What info.json says, the parts we read. */
export interface PostInfo {
	readonly id: string;
	readonly title: string | null;
	readonly createdAt: number | null;
	readonly expiresAt: number | null;
	readonly postedBy: string | null;
	/** 'blueprint', 'blueprint-book', 'upgrade-planner', 'deconstruction-planner'. */
	readonly type: string;
	readonly name: string | null;
	readonly description: string | null;
	/** Null while factoriobin is still processing the string. */
	readonly stringUrl: string | null;
	readonly stringBytes: number | null;
	readonly version: string | null;
	readonly entities: number | null;
	readonly tiles: number | null;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const time = (v: unknown) => {
	const t = typeof v === 'string' ? Date.parse(v) : NaN;
	return Number.isFinite(t) ? t : null;
};

/** info.json as PostInfo; throws when it isn't the post `id`'s root node. */
export function parseInfo(id: string, json: unknown): PostInfo {
	const o = (json ?? {}) as { post?: Record<string, unknown>; node?: Record<string, unknown> };
	const post = o.post;
	const node = o.node;
	if (!post || typeof post !== 'object' || !node || typeof node !== 'object') throw new Error('info.json has no post or node');
	if (post.id !== id) throw new Error(`info.json is for post ${String(post.id)}, not ${id}`);
	if (node.index !== 0 || (node.parentIndex !== null && node.parentIndex !== undefined)) throw new Error('info.json is not the root node');
	const stringUrl = str(node.blueprintStringUrl);
	// Only factoriobin's own CDN: the URL comes from a response, and we fetch it.
	if (stringUrl && !stringUrl.startsWith(CDN)) throw new Error(`the string is not on factoriobin's CDN: ${stringUrl}`);
	const by = post.postedBy as { username?: unknown } | null | undefined;
	return {
		id,
		title: str(post.title),
		createdAt: time(post.createdAt),
		expiresAt: time(post.expiresAt),
		postedBy: str(by?.username),
		type: str(node.type) ?? 'unknown',
		name: str(node.name),
		description: str(node.description),
		stringUrl,
		stringBytes: num(node.blueprintStringLength),
		version: str(node.factorioVersion),
		entities: num(node.numEntities),
		tiles: num(node.numTiles)
	};
}

/** URLs in a description (links to the same print elsewhere, perhaps): at most 10. */
export const linksIn = (text: string | null) => [...new Set((text ?? '').match(/https?:\/\/[^\s<>()[\]"']+/g) ?? [])].slice(0, 10);

/** The post as a SourceRecord: see the header. */
export const toSourceRecord = (info: PostInfo, blueprintString: string): SourceRecord => ({
	site: 'factoriobin',
	siteId: info.id,
	url: postUrl(info.id),
	title: info.title?.trim() || info.name?.trim() || null,
	description: info.description,
	author: info.postedBy ? { site: 'factoriobin', id: info.postedBy, name: info.postedBy } : null,
	blueprintString,
	image: null,
	uploadedAt: info.createdAt,
	updatedAt: null,
	favorites: null,
	tags: [],
	sourceHints: linksIn(info.description)
});

/** How the reader fetches: `fetch` itself, or one that caches (the Worker's Cache API, Bun's disk). */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export type ReadPost =
	| { readonly ok: true; readonly info: PostInfo; readonly record: SourceRecord }
	/** Over `maxStringBytes` by info.json's length: the string isn't fetched at all. */
	| { readonly ok: true; readonly info: PostInfo; readonly record: null; readonly tooBig: { size: number; limit: number } }
	| {
			readonly ok: false;
			readonly problem: 'not-found' | 'processing' | 'fetch-failed';
			readonly message: string;
			readonly info?: PostInfo;
	  };

const get = (fetcher: Fetcher, url: string) =>
	fetcher(url, { headers: { 'user-agent': FACTORIOBIN_USER_AGENT, accept: 'application/json, text/plain' }, redirect: 'manual' });

/** Read post `id`: info.json, then its string unless it is over `maxStringBytes`. */
export async function readPost(id: string, o: { fetch: Fetcher; maxStringBytes?: number }): Promise<ReadPost> {
	let info: PostInfo;
	try {
		const res = await get(o.fetch, infoUrl(id));
		if (res.status === 404 || res.status === 410) {
			await res.body?.cancel();
			return { ok: false, problem: 'not-found', message: `factoriobin has no post ${id} (deleted, expired or mistyped)` };
		}
		if (!res.ok) {
			await res.body?.cancel();
			return { ok: false, problem: 'fetch-failed', message: `factoriobin answered ${res.status} for post ${id}` };
		}
		info = parseInfo(id, await res.json());
	} catch (e) {
		return { ok: false, problem: 'fetch-failed', message: `reading post ${id}: ${e instanceof Error ? e.message : String(e)}` };
	}
	if (!info.stringUrl)
		return { ok: false, problem: 'processing', message: `factoriobin is still processing post ${id}; try again shortly`, info };
	const limit = o.maxStringBytes ?? MAX_STRING_BYTES;
	if (info.stringBytes !== null && info.stringBytes > limit)
		return { ok: true, info, record: null, tooBig: { size: info.stringBytes, limit } };
	try {
		const res = await get(o.fetch, info.stringUrl);
		if (!res.ok) {
			await res.body?.cancel();
			return { ok: false, problem: 'fetch-failed', message: `factoriobin's CDN answered ${res.status} for post ${id}'s string`, info };
		}
		const length = Number(res.headers.get('content-length'));
		if (length > limit) {
			await res.body?.cancel();
			return { ok: true, info, record: null, tooBig: { size: length, limit } };
		}
		const text = (await res.text()).trim();
		const bytes = new TextEncoder().encode(text).length;
		if (bytes > limit) return { ok: true, info, record: null, tooBig: { size: bytes, limit } };
		return { ok: true, info, record: toSourceRecord(info, text) };
	} catch (e) {
		return {
			ok: false,
			problem: 'fetch-failed',
			message: `reading post ${id}'s string: ${e instanceof Error ? e.message : String(e)}`,
			info
		};
	}
}

/** What the admin page shows of a post. */
export interface PostSummary {
	readonly id: string;
	readonly url: string;
	readonly title: string;
	readonly type: string;
	readonly version: string | null;
	readonly entities: number | null;
	readonly tiles: number | null;
	readonly stringBytes: number | null;
	readonly createdAt: number | null;
	readonly expiresAt: number | null;
	readonly postedBy: string | null;
	/** The book node the link named, when it named one. */
	readonly linkedNode: number | null;
}

const summaryOf = (info: PostInfo, link: PostLink): PostSummary => ({
	id: info.id,
	url: postUrl(info.id),
	title: info.title?.trim() || info.name?.trim() || 'Untitled blueprint',
	type: info.type,
	version: info.version,
	entities: info.entities,
	tiles: info.tiles,
	stringBytes: info.stringBytes,
	createdAt: info.createdAt,
	expiresAt: info.expiresAt,
	postedBy: info.postedBy,
	linkedNode: link.node
});

export type AddPostResult =
	| { readonly ok: true; readonly post: PostSummary; readonly result: AddResult }
	| {
			readonly ok: false;
			readonly problem: 'bad-link' | 'not-found' | 'processing' | 'fetch-failed';
			readonly message: string;
			readonly post?: PostSummary;
	  };

/**
 * Add the post a link names (or with `plan`, say what adding would do): read it, then `addRecord` (the
 * gate). The Worker passes its `limits`; over them the answer is 'too-big', for the local command.
 */
export async function addFactoriobinPost(
	b: AddBindings,
	link: string,
	o: { fetch: Fetcher; limits?: AdmitLimits; plan?: boolean; now?: number }
): Promise<AddPostResult> {
	const parsed = parsePostLink(link);
	if (!parsed) return { ok: false, problem: 'bad-link', message: 'Not a factoriobin post link (https://factoriobin.com/post/<id>).' };
	const read = await readPost(parsed.id, { fetch: o.fetch, maxStringBytes: o.limits?.maxStringBytes });
	if (!read.ok)
		return { ok: false, problem: read.problem, message: read.message, ...(read.info ? { post: summaryOf(read.info, parsed) } : {}) };
	const post = summaryOf(read.info, parsed);
	if (!read.record) {
		// Not fetched, so not admitted: but a post already here, or blocked, says so rather than "too big".
		const known = await knownSource(b.DB, 'factoriobin', parsed.id);
		const planned = Boolean(o.plan);
		return { ok: true, post, result: known ? { ...known, planned } : { status: 'too-big', by: 'string', ...read.tooBig, planned } };
	}
	return { ok: true, post, result: await addRecord(b, read.record, { limits: o.limits, plan: o.plan, now: o.now }) };
}
