import type { MultiFilter } from '#lib/filters.js';
import {
	atOrAbove,
	isQualityLevel,
	QUALITY_FILTERS,
	QUALITY_LEVELS,
	splitQuality,
	withQualityValue,
	type QualityLevel
} from '#lib/quality.js';
import { FOLDED_TOKEN } from './pipeline/fold';
import { atQuality, authorToken, MODULES, moduleToken, qualityToken, RENDER_TOKEN, slug, versionTokens } from './pipeline/repository';

export { MULTI_FILTERS, type MultiFilter } from '#lib/filters.js';

export interface SearchParams {
	q: string;
	/** Makes, uses and module values may end in `@<level>`: that item at that quality or above (lib/quality.ts). */
	makes: string[];
	takes: string[];
	/** Buildings, as "entity:<name>" (`?uses=entity:foundry`). Any entity matches, not only the "Built with" list. */
	uses: string[];
	/** Recipes some machine is set to, or modules, by name (`?recipe=electronic-circuit`, `?module=speed-module-3`). */
	recipe: string[];
	module: string[];
	/** Quality levels the print has something at (`?quality=legendary`); each must be there. */
	quality: string[];
	version: string[];
	/** Raw factorioprints author tags, e.g. "/general/tileable/". */
	tag: string[];
	/** One author's prints, by factorioprints user id (`?author=`; the `by_*` facet token). */
	author: string | null;
	spaceAge: 'yes' | 'no' | null;
	circuits: boolean;
	trains: boolean;
	/** Only prints with a game render in this stage's bucket (`?render=1`; print_renders, migration 0015). */
	render: boolean;
	/** `popular`: most viewed over the last 30 days (prints.views_30d, from `bun run views:sync`), then favourites. */
	sort: 'favorites' | 'recent' | 'relevance' | 'popular';
	/** 1-based results page (`?p=2`), at most MAX_PAGES. */
	page: number;
}

/** Results per page, and how deep a search can page: 20 × 60 = the first 1,200 matches. */
export const PAGE_SIZE = 60;
export const MAX_PAGES = 20;
/** Typed text past this is cut at a word (FTS cost grows with every term); about 30 words. */
export const MAX_QUERY_LENGTH = 200;
/** Values kept per repeated filter (`?makes=a&makes=b…`); the rest are dropped. */
export const MAX_FILTER_VALUES = 10;

/** Text cut to MAX_QUERY_LENGTH characters, at the last space before it when there is one. */
export const clipQuery = (q: string) => {
	if (q.length <= MAX_QUERY_LENGTH) return q;
	const cut = q.slice(0, MAX_QUERY_LENGTH + 1);
	const space = cut.lastIndexOf(' ');
	return (space > 0 ? cut.slice(0, space) : cut.slice(0, MAX_QUERY_LENGTH)).trim();
};

/** `?p=`: a whole number from 1 to MAX_PAGES; anything else is page 1, anything deeper the last page. */
export const parsePage = (v: string | null) => {
	const n = v !== null && /^\d+$/.test(v) ? Number(v) : 1;
	return Math.min(Math.max(n, 1), MAX_PAGES);
};

/**
 * Read search params from a URL. `sort` defaults to best match when there is text to match and
 * to most favourited otherwise; "relevance" without text means nothing, so it falls back too.
 */
export const parseSearch = (url: URL): SearchParams => {
	const g = (k: string) => url.searchParams.get(k)?.trim() || null;
	// Every value of a repeated filter, trimmed, blanks and repeats dropped, at most MAX_FILTER_VALUES.
	const all = (k: MultiFilter) => [...new Set(url.searchParams.getAll(k).map((v) => v.trim()))].filter(Boolean).slice(0, MAX_FILTER_VALUES);
	const sa = g('spaceAge');
	const author = g('author');
	const q = clipQuery(g('q') ?? '');
	const sort = g('sort');
	return {
		q,
		makes: all('makes'),
		takes: all('takes'),
		// A bare name ("foundry") means the entity.
		uses: [...new Set(all('uses').map((u) => (u.includes(':') ? u : `entity:${u}`)))],
		recipe: all('recipe'),
		module: all('module'),
		version: all('version'),
		tag: all('tag'),
		quality: all('quality').filter(isQualityLevel),
		// User ids are letters and digits; anything else can't be one, so it matches nothing.
		author: author === null ? null : /^[A-Za-z0-9]{1,64}$/.test(author) ? author : 'none',
		spaceAge: sa === 'yes' || sa === 'no' ? sa : null,
		circuits: g('circuits') === '1',
		trains: g('trains') === '1',
		render: g('render') === '1',
		sort: sort === 'recent' || sort === 'favorites' || sort === 'popular' ? sort : q ? 'relevance' : 'favorites',
		page: parsePage(g('p'))
	};
};

/** Free text as FTS5 phrases: every word must match, as a prefix. Quotes are stripped. */
const textQuery = (q: string) =>
	q
		.split(/\s+/)
		.map((w) => w.replace(/"/g, ''))
		.filter(Boolean)
		.map((w) => `"${w}"*`)
		.join(' ');

/** The FTS columns free text searches; `facets` only ever matches whole filter tokens. */
const TEXT_COLUMNS = '{title description labels entities recipes nicknames author}';

/** A makes, uses or module value's token, or with a quality the tokens for it and every level above (any one matches). */
const qualityTerm = (token: (base: string) => string, value: string): string[] => {
	const { base, quality } = splitQuality(value);
	return quality ? atOrAbove(quality).map((q) => atQuality(token(base), q)) : [token(base)];
};

/**
 * Filter tokens for the FTS `facets` column (written by `facetTokens` in repository.ts), one list per
 * filter: a print must have every filter, and any token of a filter's list ("epic or above" is the
 * epic and the legendary token).
 */
export const filterTokens = (s: SearchParams): string[][] => {
	const tokens: string[][] = [];
	for (const v of s.makes) tokens.push(qualityTerm((b) => `makes_${slug(b)}`, v));
	for (const v of s.takes) tokens.push([`takes_${slug(v)}`]);
	for (const v of s.uses) tokens.push(qualityTerm((b) => `uses_${slug(b)}`, v));
	for (const v of s.recipe) tokens.push([`recipe_${slug(v) || 'none'}`]);
	for (const v of s.module) tokens.push(qualityTerm(moduleToken, v));
	// "2.0" matches 2.0.x saves and "2.0" claims; a version that isn't numbers matches nothing.
	for (const v of s.version) tokens.push([versionTokens(v).at(-1) ?? 'v_none']);
	for (const v of s.tag) tokens.push([`tag_${slug(v) || 'none'}`]);
	for (const v of s.quality) tokens.push([qualityToken(v)]);
	if (s.author) tokens.push([authorToken(s.author)]);
	if (s.spaceAge) tokens.push([s.spaceAge === 'yes' ? 'sa_yes' : 'sa_no']);
	if (s.circuits) tokens.push(['uses_circuits']);
	if (s.trains) tokens.push(['uses_trains']);
	if (s.render) tokens.push([RENDER_TOKEN]);
	return tokens;
};

/**
 * One FTS5 expression for the text and every filter, e.g.
 * `({title …} : ("red"* "science"*) AND facets : "sa_no" AND facets : ("uses_entity_beacon_at_epic" OR "uses_entity_beacon_at_legendary")) NOT facets : "folded_yes"`:
 * folded copies (fold.ts) never match. Empty when the search has neither, in which case results come
 * straight from `prints` in index order.
 */
export const matchExpression = (s: SearchParams): string => {
	const text = textQuery(s.q);
	const terms = filterTokens(s).map((t) => (t.length === 1 ? `facets : "${t[0]}"` : `facets : (${t.map((x) => `"${x}"`).join(' OR ')})`));
	const all = [...(text ? [`${TEXT_COLUMNS} : (${text})`] : []), ...terms].join(' AND ');
	return all ? `(${all}) NOT facets : "${FOLDED_TOKEN}"` : '';
};

/** `match` narrowed by one more filter token. */
const andToken = (match: string, token: string) => [match, `facets : "${token}"`].filter(Boolean).join(' AND ');

/** The search with one makes/uses/module value at another quality (`null`: any quality). */
const atLevel = (s: SearchParams, key: (typeof QUALITY_FILTERS)[number], value: string, quality: QualityLevel | null): SearchParams => ({
	...s,
	[key]: s[key].map((v) => (v === value ? withQualityValue(splitQuality(v).base, quality) : v))
});

/**
 * One row, one COUNT per expression in columns `c0`, `c1`…: scalar subqueries rather than a UNION, since
 * D1 allows only a few terms in a compound SELECT.
 */
const counts = (matches: string[]): Statement =>
	matches.length
		? {
				sql: `SELECT ${matches.map((_, i) => `(SELECT COUNT(*) FROM print_search WHERE print_search MATCH ?${i + 1}) AS c${i}`).join(', ')}`,
				binds: matches
			}
		: { sql: 'SELECT 0 AS none WHERE 0', binds: [] };

/** One row of stored `facet_counts` (rebuildFacets), one per value in columns `c0`, `c1`…, as `counts`; missing is null. */
const stored = (kind: string, values: string[]): Statement => ({
	sql: `SELECT ${values.map((_, i) => `(SELECT n FROM facet_counts WHERE kind = '${kind}' AND value = ?${i + 1}) AS c${i}`).join(', ')}`,
	binds: values
});

/**
 * A quality chip's counts: the search with that makes/uses/module value at any quality, then at each
 * level or above (`/quality-levels`, fetched when the chip's choice opens rather than with every search).
 */
export const qualityLevelsStatement = (s: SearchParams, key: (typeof QUALITY_FILTERS)[number], value: string) =>
	counts([null, ...QUALITY_LEVELS].map((q) => matchExpression(atLevel(s, key, value, q))));

/** A `counts` (or `stored`) statement's numbers, in order (none when it had no expressions); null counts as 0. */
export const countsOf = (rows: Record<string, unknown>[]) => {
	const row = rows[0] ?? {};
	return Object.keys(row)
		.filter((k) => /^c\d+$/.test(k))
		.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
		.map((k) => Number(row[k]));
};

export interface PrintCard {
	id: string;
	title: string;
	author_id: string | null;
	author_name: string | null;
	favorites: number;
	image_id: string | null;
	image_type: string | null;
	updated_at: number | null;
	game_version: string | null;
	blueprint_count: number;
	entity_count: number;
	requires_space_age: number;
	uses_circuits: number;
	uses_trains: number;
	outputs: string[];
	claimed_versions: string[];
	planets: string[];
	mods: string[];
	/** 1 when the print has a game render (a print_renders row). */
	has_render: number;
	/**
	 * The cover page's thumbnail (migration 0018, set by `render:flags` once the print's thumbnails
	 * are up): book path, overview stamp and size, for thumbFile/thumbTiers in #lib/viewer/thumbs.ts.
	 * Null without one. The card shows it when there is no copy of the author's screenshot.
	 */
	cover_page: string | null;
	cover_stamp: string | null;
	cover_w: number | null;
	cover_h: number | null;
	/**
	 * Our copy of the author's screenshot (migration 0019, set by `screenshots:flags`): 'copied' (with
	 * the version its sizes were made with, the original's extension and size), 'dead' or 'removed';
	 * for cardImage in #lib/screenshots.ts. Null when there is no row: not copied yet (the card shows
	 * Imgur's copy), or the print has no screenshot.
	 */
	shot_state: string | null;
	shot_v: number | null;
	shot_ext: string | null;
	shot_w: number | null;
	shot_h: number | null;
}

/** A card's columns; `r` is print_renders and `s` screenshots, each joined by primary key (CARD_JOIN). */
const CARD = `p.id, p.title, p.author_id, p.author_name, p.favorites, p.image_id, p.image_type, p.updated_at, p.game_version,
	p.blueprint_count, p.entity_count, p.requires_space_age, p.uses_circuits, p.uses_trains,
	p.outputs, p.claimed_versions, p.planets, p.mods,
	r.print_id IS NOT NULL AS has_render, r.cover_page, r.cover_stamp, r.cover_w, r.cover_h,
	s.state AS shot_state, s.v AS shot_v, s.ext AS shot_ext, s.w AS shot_w, s.h AS shot_h`;
const CARD_JOIN = 'LEFT JOIN print_renders r ON r.print_id = p.id LEFT JOIN screenshots s ON s.image_id = p.image_id';

/** ORDER BY for the sorts that don't need a match; each has its own index on prints (migrations 0005, 0016). */
const ORDERS = { favorites: 'p.favorites DESC', recent: 'p.updated_at DESC', popular: 'p.views_30d DESC, p.favorites DESC' };

/** Title counts most for relevance, then the author, page labels and nicknames (weights by FTS column). */
const RELEVANCE = 'bm25(print_search, 0, 10, 1, 3, 1, 1, 2, 5, 0)';

export interface Statement {
	sql: string;
	binds: unknown[];
}

export type SearchStatements = Record<'results' | 'total' | 'makes' | 'uses' | 'versions' | 'modules' | 'qualities', Statement>;

/**
 * The queries behind the search page: one page of result cards, the number of matches, "Makes",
 * "Built with", version, module and quality counts. Unfiltered searches read precomputed
 * `facet_counts`; filtered ones count exactly over the FTS matches (modules and qualities with one FTS
 * COUNT each, `counts`, in MODULES and QUALITY_LEVELS order). Pure, so tests can EXPLAIN them (search.test.ts).
 */
export const searchStatements = (s: SearchParams): SearchStatements => {
	const match = matchExpression(s);
	const page = `LIMIT ${PAGE_SIZE} OFFSET ${(parsePage(String(s.page)) - 1) * PAGE_SIZE}`;
	if (!match) {
		const order = ORDERS[s.sort === 'relevance' ? 'favorites' : s.sort];
		return {
			modules: stored('module', MODULES),
			qualities: stored('quality', [...QUALITY_LEVELS]),
			// Folded copies (fold.ts) left out: the column filters the index walk; the count subtracts them by their partial index.
			results: { sql: `SELECT ${CARD} FROM prints p ${CARD_JOIN} WHERE p.duplicate_of IS NULL ORDER BY ${order} ${page}`, binds: [] },
			total: {
				sql: 'SELECT (SELECT COUNT(*) FROM prints) - (SELECT COUNT(*) FROM prints WHERE duplicate_of IS NOT NULL) AS n',
				binds: []
			},
			makes: { sql: `SELECT value, n FROM facet_counts WHERE kind = 'makes' ORDER BY n DESC, value`, binds: [] },
			uses: { sql: `SELECT value, n FROM facet_counts WHERE kind = 'uses' ORDER BY n DESC, value`, binds: [] },
			versions: { sql: `SELECT value, n FROM facet_counts WHERE kind = 'version' ORDER BY value`, binds: [] }
		};
	}
	const order = s.sort === 'relevance' ? RELEVANCE : ORDERS[s.sort];
	const matched = 'SELECT print_id FROM print_search WHERE print_search MATCH ?1';
	return {
		modules: counts(MODULES.map((m) => andToken(match, moduleToken(m)))),
		qualities: counts(QUALITY_LEVELS.map((q) => andToken(match, qualityToken(q)))),
		results: {
			sql: `SELECT ${CARD} FROM print_search JOIN prints p ON p.id = print_search.print_id ${CARD_JOIN}
				WHERE print_search MATCH ?1 ORDER BY ${order} ${page}`,
			binds: [match]
		},
		total: { sql: 'SELECT COUNT(*) AS n FROM print_search WHERE print_search MATCH ?1', binds: [match] },
		makes: {
			sql: `SELECT item AS value, COUNT(*) AS n FROM print_items
				WHERE role = 'output' AND print_id IN (${matched}) GROUP BY item ORDER BY n DESC, value`,
			binds: [match]
		},
		uses: {
			sql: `SELECT entity AS value, COUNT(*) AS n FROM print_uses
				WHERE print_id IN (${matched}) GROUP BY entity ORDER BY n DESC, value`,
			binds: [match]
		},
		versions: {
			sql: `SELECT v.value AS value, COUNT(*) AS n FROM prints p, json_each(p.claimed_versions) v
				WHERE p.id IN (${matched}) GROUP BY v.value ORDER BY v.value`,
			binds: [match]
		}
	};
};

export const searchPrints = async (db: D1Database, s: SearchParams) => {
	const q = searchStatements(s);
	const [rows, total, makes, uses, versions, modules, qualities] = await db.batch<Record<string, unknown>>(
		[q.results, q.total, q.makes, q.uses, q.versions, q.modules, q.qualities].map((st) => db.prepare(st.sql).bind(...st.binds))
	);
	const matches = Number(total.results?.[0]?.n ?? 0);
	const parse = (v: unknown) => (typeof v === 'string' ? (JSON.parse(v) as string[]) : []);
	const byIndex = (r: D1Result<Record<string, unknown>>) => countsOf(r.results ?? []);
	const moduleCounts = byIndex(modules);
	const qualityCounts = byIndex(qualities);
	return {
		results: (rows.results ?? []).map(
			(r) =>
				({
					...r,
					outputs: parse(r.outputs),
					claimed_versions: parse(r.claimed_versions),
					planets: parse(r.planets),
					mods: parse(r.mods)
				}) as PrintCard
		),
		/** Every match, and the pages they fill (at most MAX_PAGES, however many match). */
		total: matches,
		pages: Math.min(Math.ceil(matches / PAGE_SIZE), MAX_PAGES),
		facets: {
			makes: (makes.results ?? []) as { value: string; n: number }[],
			uses: (uses.results ?? []) as { value: string; n: number }[],
			versions: (versions.results ?? []) as { value: string; n: number }[],
			/** Modules any match has, most used first. */
			modules: MODULES.map((value, i) => ({ value, n: moduleCounts[i] ?? 0 }))
				.filter((m) => m.n > 0)
				.sort((a, b) => b.n - a.n),
			/** Matches with something at each level, lowest level first. */
			qualities: QUALITY_LEVELS.map((value, i) => ({ value, n: qualityCounts[i] ?? 0 }))
		}
	};
};
