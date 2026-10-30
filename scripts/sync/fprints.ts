/**
 * fprints.xyz as a polled site (polled.ts): its sitemap lists every public print, and the import API the
 * site offers to other sites gives one print's record. No account or key.
 *
 *   GET https://fprints.xyz/sitemap.xml                       every public print as `/blueprint/<uuid>`, with
 *                                                             `lastmod` (the record's `updated_at`); one request
 *   GET <FPRINTS_API>?id=<uuid>                               one print: the site's `blueprints` row
 *
 * The sitemap is the whole list (`listsAll`), so every update compares it with what this machine has: new
 * uuids and moved lastmods are read, and a print the sitemap no longer lists is read once to confirm it is
 * gone (the API answers HTTP 500 "JSON object requested, multiple (or no) rows returned" for an unknown id).
 * A print's revision is its lastmod and FPRINTS_RECORD_VERSION.
 *
 * The record (`fprintsRecord`): the string, title, description, created/updated times, the game version
 * the uploader chose as a version tag, `remixed_from_url` and links in the description as `sourceHints`, and
 * its image (`image_url`, on fprints' Bunny CDN) as a site image (screenshots/site-images.ts). The API gives
 * the author's user id but not their name, and no tags (both live only in the site's own database views,
 * which we don't read), so the author is credited by fprints' link alone. Copy counts are not kept.
 */
import type { SourceRecord } from '#lib/server/pipeline/source-record.js';
import { siteUrl } from '#lib/sources.js';
import { siteImage } from '../screenshots/site-images';
import { linksIn, time, versionTag, type Fetched, type ListPage, type PolledSite, type PoliteHttp } from './polled';

export const FPRINTS_ORIGIN = 'https://fprints.xyz';
export const FPRINTS_SITEMAP = `${FPRINTS_ORIGIN}/sitemap.xml`;
/** The import API fprints.xyz offers to other sites (a Supabase edge function). */
export const FPRINTS_API = 'https://tutpmokznoxsgodpklag.supabase.co/functions/v1/fprints-api';

/**
 * Part of every revision: bump it when `fprintsRecord` changes what it makes, and the next update reads every
 * print again (≈ 430 reads) and admits those whose record changed.
 */
export const FPRINTS_RECORD_VERSION = 1;
export const fprintsRev = (lastmod: number | null) => `${lastmod ?? ''}#${FPRINTS_RECORD_VERSION}`;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const FPRINTS_UUID = new RegExp(`^${UUID}$`);

/** The print's page on the site (src/lib/sources.ts, the one site table). */
export const fprintsUrl = (uuid: string) => siteUrl('fprints', uuid) ?? `${FPRINTS_ORIGIN}/blueprint/${uuid}`;

/** One print as the sitemap lists it: its uuid, and its `lastmod` (unix ms; null when missing or unreadable). */
export interface SitemapEntry {
	uuid: string;
	lastmod: number | null;
}

/**
 * The prints a sitemap lists, in its order, each once; other URLs (the home page) are skipped. Throws when the
 * text isn't a sitemap (an error page), so a broken answer never reads as "every print deleted".
 */
export function parseSitemap(xml: string): SitemapEntry[] {
	if (!/<urlset[\s>]/.test(xml)) throw new Error(`${FPRINTS_SITEMAP}: not a sitemap`);
	const prints = new Map<string, SitemapEntry>();
	const loc = new RegExp(`^${FPRINTS_ORIGIN.replace(/\./g, '\\.')}/blueprint/(${UUID})/?$`);
	for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
		const at = /<loc>\s*([^<\s]+)\s*<\/loc>/.exec(m[1])?.[1];
		const uuid = at ? loc.exec(at)?.[1] : undefined;
		if (!uuid || prints.has(uuid)) continue;
		prints.set(uuid, { uuid, lastmod: time(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/.exec(m[1])?.[1]) });
	}
	return [...prints.values()];
}

/** The `blueprints` row the import API returns (the fields read; it also has `components`, `copy_count` and display settings). */
export interface FprintsRow {
	id?: string;
	user_id?: string | null;
	title?: string | null;
	description?: string | null;
	blueprint_string?: string | null;
	created_at?: string | null;
	updated_at?: string | null;
	is_public?: boolean | null;
	image_url?: string | null;
	game_version?: string | null;
	type?: string | null;
	remixed_from_url?: string | null;
	remixed_from_title?: string | null;
}

/** The API's answer for an id it has no row for (PostgREST's "single row" error, as HTTP 500). */
export const noSuchRow = (status: number, text: string) => status === 500 && /multiple \(or no\) rows returned/.test(text);

/** The SourceRecord of a row the API answered, or gone when it isn't public. Throws when it has no string or is another print. */
export function fprintsRecord(uuid: string, row: FprintsRow): Fetched {
	if (row.id !== uuid) throw new Error(`fprints ${uuid}: the API answered for ${String(row.id)}`);
	if (row.is_public !== true) return { gone: 'no longer public' };
	const blueprintString = row.blueprint_string?.trim();
	if (!blueprintString) throw new Error(`fprints ${uuid}: no blueprint string`);
	const description = row.description?.trim() || null;
	const remix = row.remixed_from_url?.trim();
	const tag = versionTag(row.game_version);
	const record: SourceRecord = {
		site: 'fprints',
		siteId: uuid,
		url: fprintsUrl(uuid),
		title: row.title?.trim() || null,
		description,
		// The API names the uploader by user id only: credited by the link to fprints, with no name.
		author: row.user_id ? { site: 'fprints', id: row.user_id, name: null } : null,
		blueprintString,
		// The uploader's own image (fprints' Bunny CDN): copied by `screenshots --from-sites`, never hotlinked.
		image: siteImage('fprints', row.image_url),
		uploadedAt: time(row.created_at),
		updatedAt: time(row.updated_at),
		favorites: null,
		tags: tag ? [tag] : [],
		sourceHints: [...new Set([...(remix && /^https?:\/\//.test(remix) ? [remix] : []), ...linksIn(description)])].slice(0, 20)
	};
	return { record };
}

export const fprintsSite: PolledSite = {
	site: 'fprints',
	kind: 'fprints.xyz sitemap',
	version: FPRINTS_RECORD_VERSION,
	listsAll: true,
	async listPage(page: number, http: PoliteHttp, signal?: AbortSignal): Promise<ListPage> {
		if (page !== 1) return { items: [], total: 0, totalPages: 1 };
		const { status, body } = await http.get(FPRINTS_SITEMAP, 'list', signal, { text: true });
		if (typeof body !== 'string') throw new Error(`${FPRINTS_SITEMAP}: HTTP ${status}`);
		const prints = parseSitemap(body);
		return {
			items: prints.map((p) => ({ siteId: p.uuid, rev: fprintsRev(p.lastmod), updatedAt: p.lastmod ?? 0 })),
			total: prints.length,
			totalPages: 1
		};
	},
	async fetchRecord(siteId: string, http: PoliteHttp, signal?: AbortSignal): Promise<Fetched> {
		if (!FPRINTS_UUID.test(siteId)) throw new Error(`fprints ${siteId}: not an fprints id`);
		const { status, body } = await http.get(`${FPRINTS_API}?id=${siteId}`, 'read', signal, { goneIf: noSuchRow });
		if (body === null) return { gone: status === 500 ? 'no such print' : `HTTP ${status}` };
		if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`fprints ${siteId}: not a print`);
		return fprintsRecord(siteId, body as FprintsRow);
	}
};
