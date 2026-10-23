/**
 * Which search URLs search engines should index: the home page, and landing pages for one `makes`
 * or one `uses` value ("Electronic circuit blueprints"), with nothing else that changes the results.
 * Every other search (text, several filters, a sort, other filters, a results page past the first)
 * is `noindex, follow`, and links to one carry `rel="nofollow"`, so crawlers spend their time on
 * prints (all in the sitemap) and landing pages.
 */
import { MULTI_FILTERS } from './filters.js';

/** Query keys that change a search's results or their order; anything else (utm_…, fbclid) doesn't. */
const SEARCH_KEYS = ['q', ...MULTI_FILTERS, 'spaceAge', 'circuits', 'trains', 'render', 'sort', 'p'];

export type Landing = { key: 'makes' | 'uses'; value: string };
export type SearchPage = { kind: 'home' } | ({ kind: 'landing' } & Landing) | null;

/** What a search URL is to search engines: the home page, a landing page, or neither (null). */
export const searchPage = (params: Pick<URLSearchParams, 'getAll'>): SearchPage => {
	const set = SEARCH_KEYS.flatMap((key) =>
		[...new Set(params.getAll(key).map((v) => v.trim()))].filter(Boolean).map((value) => ({ key, value }))
	);
	// Most favourited is the default order without text, so `sort=favorites` is the same page; so is `p=1`.
	const rest = set.filter((p) => !(p.key === 'sort' && p.value === 'favorites') && !(p.key === 'p' && p.value === '1'));
	if (rest.length === 0) return { kind: 'home' };
	if (rest.length > 1) return null;
	const [{ key, value }] = rest;
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
