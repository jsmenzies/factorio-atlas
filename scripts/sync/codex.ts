/**
 * factoriocodex.com as a polled site (polled.ts): its public JSON API, no account needed.
 *
 *   GET /api/v1/blueprints?sort=updated_at&page=N&per_page=100   the list, most recently changed first;
 *                                                                 no strings; `{ data, total, total_pages }`
 *   GET /api/v1/blueprints/{id}?skip_view=true                    one print with every version's string
 *                                                                 (without skip_view a read counts a view)
 *
 * A print's revision is its `updated_at` and CODEX_RECORD_VERSION. A print that answers 404, or is no longer public, is gone.
 *
 * The record (`codexRecord`): the current version's string (older distinct strings in `versions`), title,
 * markdown description, the author's username unless posted anonymously, created/updated times, tags that
 * mean the same as a factorioprints tag (CODEX_TAGS; the rest are dropped), the game version the uploader
 * chose as a version tag, links in the description as `sourceHints`, and its image (`image_url`, on Backblaze
 * B2) as a site image (screenshots/site-images.ts). Favourites and views are not kept.
 */
import type { SourceRecord } from '#lib/server/pipeline/source-record.js';
import { siteUrl } from '#lib/sources.js';
import { siteImage } from '../screenshots/site-images';
import { linksIn, time, versionTag, type Fetched, type ListPage, type PolledSite, type PoliteHttp } from './polled';

export const CODEX_API = 'https://factoriocodex.com/api/v1';
const PER_PAGE = 100;

/**
 * Part of every revision: bump it when `codexRecord` changes what it makes, and the next update reads every
 * print again (≈ 460 reads) and admits those whose record changed.
 */
export const CODEX_RECORD_VERSION = 1;
export const codexRev = (updatedAt: string) => `${updatedAt}#${CODEX_RECORD_VERSION}`;

/** The print's page on the site (src/lib/sources.ts, the one site table). */
export const codexUrl = (id: string) => siteUrl('codex', id) ?? `https://factoriocodex.com/blueprints/${id}`;

interface CodexTag {
	name: string;
	category?: string;
}

interface CodexVersion {
	version_number: number;
	blueprint_string: string;
	game_version?: string | null;
	created_at?: string;
}

/** A print as the API gives it (the fields read). */
export interface CodexBlueprint {
	id: number;
	title: string | null;
	description: string | null;
	user_id: number | null;
	is_public: boolean;
	is_anonymous?: boolean;
	created_at: string;
	updated_at: string;
	image_url?: string | null;
	game_version?: string | null;
	current_version?: number;
	author?: { id: number; username: string } | null;
	tags?: CodexTag[] | null;
	versions?: CodexVersion[] | null;
}

/** codex tag → the factorioprints tag that means the same (tags.ts parses them). Unlisted tags are dropped. */
export const CODEX_TAGS: Record<string, string> = {
	'Early Game': '/general/early game/',
	Bootstrap: '/general/early game/',
	'Starter Base': '/general/early game/',
	'Mid Game': '/general/mid game/',
	'Late Game': '/general/late game (megabase)/',
	'End Game': '/general/late game (megabase)/',
	Megabase: '/general/late game (megabase)/',
	Compact: '/general/compact/',
	'Space Efficient': '/general/compact/',
	Tileable: '/general/tileable/',
	'Beacon Optimized': '/general/beaconized/',
	'UPS Optimized': '/general/ups friendly/',
	'UPS Friendly': '/general/ups friendly/',
	'Train Junction': '/train/junction/',
	'Train Roundabout': '/train/roundabout/',
	'Train Stacker': '/train/stacker/',
	'Rail Grid': '/train/track/',
	'Belt Balancer': '/belt/balancer/',
	'Belt Prioritizer': '/belt/prioritizer/',
	'Belt Tap': '/belt/tap/',
	'Solar Power': '/power/solar/',
	'Nuclear Power': '/power/nuclear/',
	'Steam Power': '/power/steam/',
	Mall: '/production/mall (make everything)/',
	'Mall Design': '/production/mall (make everything)/',
	'Mall Base': '/production/mall (make everything)/',
	Smelting: '/production/smelting/',
	'Oil Processing': '/production/oil processing/',
	'Plastic Production': '/production/plastic/',
	'Red Circuits': '/production/advanced circuit (red)/',
	'Green Circuits': '/production/electronic circuit (green)/',
	'Blue Circuits': '/production/processing unit (blue)/',
	'Belt Based': '/production/belt based/',
	'Bot Based': '/production/logistic (bot) based/',
	Science: '/production/science/',
	'Science Complex': '/production/science/',
	'Perimeter Defense': '/combat/defense/',
	'Defense Wall': '/combat/defense/',
	'Space Age': '/mods/space-age/',
	'Space Age Expansion': '/mods/space-age/',
	'Space Platform': '/planets/space-platform/',
	'Spaceship Design': '/planets/space-platform/',
	'Nauvis Planet': '/planets/nauvis/',
	'Vulcanus Planet': '/planets/vulcanus/',
	'Fulgora Planet': '/planets/fulgora/',
	'Gleba Planet': '/planets/gleba/',
	'Aquilo Planet': '/planets/aquilo/'
};

export const codexTags = (tags: readonly CodexTag[] | null | undefined, gameVersion: string | null | undefined) => {
	const out = new Set<string>();
	const chosen = versionTag(gameVersion);
	if (chosen) out.add(chosen);
	for (const t of tags ?? []) {
		const mapped = CODEX_TAGS[t.name] ?? versionTag(t.name);
		if (mapped) out.add(mapped);
	}
	return [...out];
};

/** The SourceRecord of a print the API answered, or gone when it isn't public. Throws when it has no string. */
export function codexRecord(b: CodexBlueprint): Fetched {
	if (!b.is_public) return { gone: 'no longer public' };
	const versions = [...(b.versions ?? [])].filter((v) => typeof v.blueprint_string === 'string' && v.blueprint_string.trim());
	versions.sort((a, z) => z.version_number - a.version_number);
	const current = versions.find((v) => v.version_number === b.current_version) ?? versions[0];
	if (!current) throw new Error(`codex ${b.id}: no blueprint string`);
	const blueprintString = current.blueprint_string.trim();
	const older = [...new Set(versions.filter((v) => v !== current).map((v) => v.blueprint_string.trim()))].filter(
		(s) => s !== blueprintString
	);
	const author =
		!b.is_anonymous && b.author?.username ? { site: 'codex' as const, id: String(b.author.id), name: b.author.username } : null;
	const description = b.description?.trim() || null;
	const record: SourceRecord = {
		site: 'codex',
		siteId: String(b.id),
		url: codexUrl(String(b.id)),
		title: b.title?.trim() || null,
		description,
		author,
		blueprintString,
		...(older.length ? { versions: older } : {}),
		// The uploader's own image (Backblaze B2): copied by `screenshots --from-sites`, never hotlinked.
		image: siteImage('codex', b.image_url),
		uploadedAt: time(b.created_at),
		updatedAt: time(b.updated_at),
		favorites: null,
		tags: codexTags(b.tags, current.game_version ?? b.game_version),
		sourceHints: linksIn(description)
	};
	return { record };
}

export const codexSite: PolledSite = {
	site: 'codex',
	version: CODEX_RECORD_VERSION,
	async listPage(page: number, http: PoliteHttp, signal?: AbortSignal): Promise<ListPage> {
		const url = `${CODEX_API}/blueprints?sort=updated_at&page=${page}&per_page=${PER_PAGE}`;
		const { body } = await http.get(url, 'list', signal);
		const b = body as { data?: CodexBlueprint[]; total?: number; total_pages?: number } | null;
		if (!b || !Array.isArray(b.data) || typeof b.total !== 'number') throw new Error(`${url}: not a list of prints`);
		return {
			items: b.data
				.filter((d) => d.is_public !== false && Number.isInteger(d.id))
				.map((d) => ({ siteId: String(d.id), rev: codexRev(d.updated_at), updatedAt: time(d.updated_at) ?? 0 })),
			total: b.total,
			totalPages: b.total_pages ?? Math.ceil(b.total / PER_PAGE)
		};
	},
	async fetchRecord(siteId: string, http: PoliteHttp, signal?: AbortSignal): Promise<Fetched> {
		if (!/^\d{1,12}$/.test(siteId)) throw new Error(`codex ${siteId}: not a codex id`);
		const { status, body } = await http.get(`${CODEX_API}/blueprints/${siteId}?skip_view=true`, 'read', signal);
		if (status === 404 || status === 410) return { gone: `HTTP ${status}` };
		const b = body as CodexBlueprint | null;
		if (!b || typeof b !== 'object' || String(b.id) !== siteId) throw new Error(`codex ${siteId}: not a print`);
		return codexRecord(b);
	}
};
