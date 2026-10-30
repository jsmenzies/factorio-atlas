/**
 * Which search URLs search engines should index: the home page, and landing pages for one `makes`
 * or one `uses` value ("Electronic circuit blueprints") at any quality, with nothing else that changes the results.
 * Every other search (text, several filters, a sort, other filters, a results page past the first)
 * is `noindex, follow`, and links to one carry `rel="nofollow"`, so crawlers spend their time on
 * prints (all in the sitemap) and landing pages. Googlebot follows nofollow links anyway, so robots.txt
 * (robotsTxt in lib/server/sitemap.ts) blocks the same URLs; keep the two in step.
 */
import { MULTI_FILTERS } from './filters.js';
import { isQualityLevel, splitQuality } from './quality.js';

/** Query keys that change a search's results or their order; anything else (utm_…, fbclid) doesn't. */
const SEARCH_KEYS = ['q', ...MULTI_FILTERS, 'author', 'spaceAge', 'circuits', 'trains', 'render', 'sort', 'p'];

export type SortOrder = 'favorites' | 'recent' | 'relevance' | 'popular';

type Params = Pick<URLSearchParams, 'get' | 'getAll'>;
const given = (params: Params, key: string) => params.getAll(key).some((v) => v.trim() !== '');

/**
 * Whether a search URL filters the prints, as parseSearch reads it (lib/server/queries.ts): a value for any
 * repeated filter (a quality only when it is a level), an author, Space Age yes/no, circuits, trains or render.
 */
export const isFiltered = (params: Params) =>
	MULTI_FILTERS.some((k) => (k === 'quality' ? params.getAll(k).some((v) => isQualityLevel(v.trim())) : given(params, k))) ||
	given(params, 'author') ||
	['yes', 'no'].includes(params.get('spaceAge')?.trim() ?? '') ||
	['circuits', 'trains', 'render'].some((k) => params.get(k)?.trim() === '1');

/**
 * The order a search URL has without `sort`: best match with text to match; most favourited with any filter
 * (landing pages, an author's prints); newest first (`recent`) on the home page, with neither.
 */
export const defaultSort = (params: Params): SortOrder =>
	params.get('q')?.trim() ? 'relevance' : isFiltered(params) ? 'favorites' : 'recent';

export type Landing = { key: 'makes' | 'uses'; value: string };
export type SearchPage = { kind: 'home' } | ({ kind: 'landing' } & Landing) | null;

/** What a search URL is to search engines: the home page, a landing page, or neither (null). */
export const searchPage = (params: Params): SearchPage => {
	const set = SEARCH_KEYS.flatMap((key) =>
		[...new Set(params.getAll(key).map((v) => v.trim()))].filter(Boolean).map((value) => ({ key, value }))
	);
	// The default order is the same page (`sort=recent` on the home page, `sort=favorites` on a landing page); so is `p=1`.
	const order = defaultSort(params);
	const rest = set.filter((p) => !(p.key === 'sort' && p.value === order) && !(p.key === 'p' && p.value === '1'));
	if (rest.length === 0) return { kind: 'home' };
	if (rest.length > 1) return null;
	const [{ key, value }] = rest;
	// An item at a quality (`?uses=entity:beacon@epic`) is a narrower search, not the item's landing page.
	if (splitQuality(value).quality) return null;
	if (key === 'makes') return { kind: 'landing', key, value };
	// A bare building name ("foundry") means the entity, as in parseSearch.
	if (key === 'uses') return { kind: 'landing', key, value: value.includes(':') ? value : `entity:${value}` };
	return null;
};

/** A landing page's one URL, its canonical. */
export const landingPath = (l: Landing) => `/?${l.key}=${encodeURIComponent(l.value)}`;

/** `rel` for a link into search: nofollow unless it leads to the home page or a landing page. */
export const searchRel = (href: string) => (searchPage(new URL(href, 'http://x').searchParams) ? undefined : 'nofollow');

/** A landing page's title and description, from the item or building's English name and how many prints there are. */
export const landingMeta = (l: Landing, label: string, n: number) => {
	const prints = `${n} Factorio blueprint${n === 1 ? '' : 's'}`;
	const what = l.key === 'makes' ? `that make${n === 1 ? 's' : ''} ${label}` : `built with ${label}`;
	return {
		title: `${label} blueprints for Factorio · Blueprint Atlas`,
		description: `${prints} ${what}, decoded and analysed: rates, game version, Space Age. Sorted by favourites.`
	};
};
