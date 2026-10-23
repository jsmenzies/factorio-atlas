import type { MultiFilter } from '#lib/filters.js';
import { RENDER_TOKEN, slug, versionTokens } from './pipeline/repository';

export { MULTI_FILTERS, type MultiFilter } from '#lib/filters.js';

export interface SearchParams {
	q: string;
	makes: string[];
	takes: string[];
	/** Buildings, as "entity:<name>" (`?uses=entity:foundry`). Any entity matches, not only the "Built with" list. */
	uses: string[];
	/** Recipes some machine is set to, or modules, by name (`?recipe=electronic-circuit`, `?module=speed-module-3`). */
	recipe: string[];
	module: string[];
	version: string[];
	/** Raw factorioprints author tags, e.g. "/general/tileable/". */
	tag: string[];
	spaceAge: 'yes' | 'no' | null;
	circuits: boolean;
	trains: boolean;
	/** Only prints with a game render in this stage's bucket (`?render=1`; print_renders, migration 0015). */
	render: boolean;
	sort: 'favorites' | 'recent' | 'relevance';
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
		spaceAge: sa === 'yes' || sa === 'no' ? sa : null,
		circuits: g('circuits') === '1',
		trains: g('trains') === '1',
		render: g('render') === '1',
		sort: sort === 'recent' || sort === 'favorites' ? sort : q ? 'relevance' : 'favorites',
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
const TEXT_COLUMNS = '{title description labels entities recipes nicknames}';

/** Filter tokens for the FTS `facets` column (written by `facetTokens` in repository.ts). */
export const filterTokens = (s: SearchParams): string[] => {
	const tokens: string[] = [];
	for (const v of s.makes) tokens.push(`makes_${slug(v)}`);
	for (const v of s.takes) tokens.push(`takes_${slug(v)}`);
	for (const v of s.uses) tokens.push(`uses_${slug(v)}`);
	for (const v of s.recipe) tokens.push(`recipe_${slug(v) || 'none'}`);
	for (const v of s.module) tokens.push(`module_${slug(v) || 'none'}`);
	// "2.0" matches 2.0.x saves and "2.0" claims; a version that isn't numbers matches nothing.
	for (const v of s.version) tokens.push(versionTokens(v).at(-1) ?? 'v_none');
	for (const v of s.tag) tokens.push(`tag_${slug(v) || 'none'}`);
	if (s.spaceAge) tokens.push(s.spaceAge === 'yes' ? 'sa_yes' : 'sa_no');
	if (s.circuits) tokens.push('uses_circuits');
	if (s.trains) tokens.push('uses_trains');
	if (s.render) tokens.push(RENDER_TOKEN);
	return tokens;
};

/**
 * One FTS5 expression for the text and every filter, e.g.
 * `{title …} : ("red"* "science"*) AND facets : "sa_no" AND facets : "v_2_0"`. Empty when the
 * search has neither, in which case results come straight from `prints` in index order.
 */
export const matchExpression = (s: SearchParams): string => {
	const text = textQuery(s.q);
	return [...(text ? [`${TEXT_COLUMNS} : (${text})`] : []), ...filterTokens(s).map((t) => `facets : "${t}"`)].join(' AND ');
};

export interface PrintCard {
	id: string;
	title: string;
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
}

const CARD = `p.id, p.title, p.author_name, p.favorites, p.image_id, p.image_type, p.updated_at, p.game_version,
	p.blueprint_count, p.entity_count, p.requires_space_age, p.uses_circuits, p.uses_trains,
	p.outputs, p.claimed_versions, p.planets, p.mods,
	EXISTS (SELECT 1 FROM print_renders r WHERE r.print_id = p.id) AS has_render`;

/** Title counts most for relevance, then page labels and nicknames (weights by FTS column). */
const RELEVANCE = 'bm25(print_search, 0, 10, 1, 3, 1, 1, 2, 0)';

export interface Statement {
	sql: string;
	binds: unknown[];
}

export type SearchStatements = Record<'results' | 'total' | 'makes' | 'uses' | 'versions', Statement>;

/**
 * The queries behind the search page: one page of result cards, the number of matches, "Makes",
 * "Built with" and version counts. Unfiltered searches read precomputed `facet_counts`; filtered
 * ones count exactly over the FTS matches. Pure, so tests can EXPLAIN them (search.test.ts).
 */
export const searchStatements = (s: SearchParams): SearchStatements => {
	const match = matchExpression(s);
	const page = `LIMIT ${PAGE_SIZE} OFFSET ${(parsePage(String(s.page)) - 1) * PAGE_SIZE}`;
	if (!match) {
		const order = s.sort === 'recent' ? 'p.updated_at DESC' : 'p.favorites DESC';
		return {
			results: { sql: `SELECT ${CARD} FROM prints p ORDER BY ${order} ${page}`, binds: [] },
			total: { sql: 'SELECT COUNT(*) AS n FROM prints', binds: [] },
			makes: { sql: `SELECT value, n FROM facet_counts WHERE kind = 'makes' ORDER BY n DESC, value`, binds: [] },
			uses: { sql: `SELECT value, n FROM facet_counts WHERE kind = 'uses' ORDER BY n DESC, value`, binds: [] },
			versions: { sql: `SELECT value, n FROM facet_counts WHERE kind = 'version' ORDER BY value`, binds: [] }
		};
	}
	const order = s.sort === 'recent' ? 'p.updated_at DESC' : s.sort === 'relevance' ? RELEVANCE : 'p.favorites DESC';
	const matched = 'SELECT print_id FROM print_search WHERE print_search MATCH ?1';
	return {
		results: {
			sql: `SELECT ${CARD} FROM print_search JOIN prints p ON p.id = print_search.print_id
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
	const [rows, total, makes, uses, versions] = await db.batch<Record<string, unknown>>(
		[q.results, q.total, q.makes, q.uses, q.versions].map((st) => db.prepare(st.sql).bind(...st.binds))
	);
	const matches = Number(total.results?.[0]?.n ?? 0);
	const parse = (v: unknown) => (typeof v === 'string' ? (JSON.parse(v) as string[]) : []);
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
			versions: (versions.results ?? []) as { value: string; n: number }[]
		}
	};
};
