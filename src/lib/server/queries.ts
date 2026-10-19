import { slug, versionTokens } from './pipeline/repository';

export interface SearchParams {
	q: string;
	makes: string | null;
	takes: string | null;
	/** A building, as "entity:<name>" (`?uses=entity:foundry`). Any entity matches, not only the "Built with" list. */
	uses: string | null;
	/** A recipe some machine is set to, or a module, by name (`?recipe=electronic-circuit`, `?module=speed-module-3`). */
	recipe: string | null;
	module: string | null;
	version: string | null;
	/** A raw factorioprints author tag, e.g. "/general/tileable/". */
	tag: string | null;
	spaceAge: 'yes' | 'no' | null;
	circuits: boolean;
	trains: boolean;
	sort: 'favorites' | 'recent' | 'relevance';
}

/**
 * Read search params from a URL. `sort` defaults to best match when there is text to match and
 * to most favourited otherwise; "relevance" without text means nothing, so it falls back too.
 */
export const parseSearch = (url: URL): SearchParams => {
	const g = (k: string) => url.searchParams.get(k)?.trim() || null;
	const sa = g('spaceAge');
	const q = g('q') ?? '';
	const sort = g('sort');
	const uses = g('uses');
	return {
		q,
		makes: g('makes'),
		takes: g('takes'),
		// A bare name ("foundry") means the entity.
		uses: uses && !uses.includes(':') ? `entity:${uses}` : uses,
		recipe: g('recipe'),
		module: g('module'),
		version: g('version'),
		tag: g('tag'),
		spaceAge: sa === 'yes' || sa === 'no' ? sa : null,
		circuits: g('circuits') === '1',
		trains: g('trains') === '1',
		sort: sort === 'recent' || sort === 'favorites' ? sort : q ? 'relevance' : 'favorites'
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
	if (s.makes) tokens.push(`makes_${slug(s.makes)}`);
	if (s.takes) tokens.push(`takes_${slug(s.takes)}`);
	if (s.uses) tokens.push(`uses_${slug(s.uses)}`);
	if (s.recipe) tokens.push(`recipe_${slug(s.recipe) || 'none'}`);
	if (s.module) tokens.push(`module_${slug(s.module) || 'none'}`);
	// "2.0" matches 2.0.x saves and "2.0" claims; a version that isn't numbers matches nothing.
	if (s.version) tokens.push(versionTokens(s.version).at(-1) ?? 'v_none');
	if (s.tag) tokens.push(`tag_${slug(s.tag) || 'none'}`);
	if (s.spaceAge) tokens.push(s.spaceAge === 'yes' ? 'sa_yes' : 'sa_no');
	if (s.circuits) tokens.push('uses_circuits');
	if (s.trains) tokens.push('uses_trains');
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
}

const CARD = `p.id, p.title, p.author_name, p.favorites, p.image_id, p.image_type, p.updated_at, p.game_version,
	p.blueprint_count, p.entity_count, p.requires_space_age, p.uses_circuits, p.uses_trains,
	p.outputs, p.claimed_versions, p.planets, p.mods`;

/** Title counts most for relevance, then page labels and nicknames (weights by FTS column). */
const RELEVANCE = 'bm25(print_search, 0, 10, 1, 3, 1, 1, 2, 0)';

export const PAGE_SIZE = 60;

export interface Statement {
	sql: string;
	binds: unknown[];
}

/**
 * The queries behind the search page: result cards, "Makes", "Built with" and version counts.
 * Unfiltered searches read precomputed `facet_counts`; filtered ones count exactly over the
 * FTS matches. Pure, so tests can EXPLAIN them (search.test.ts).
 */
export const searchStatements = (s: SearchParams): { results: Statement; makes: Statement; uses: Statement; versions: Statement } => {
	const match = matchExpression(s);
	if (!match) {
		const order = s.sort === 'recent' ? 'p.updated_at DESC' : 'p.favorites DESC';
		return {
			results: { sql: `SELECT ${CARD} FROM prints p ORDER BY ${order} LIMIT ${PAGE_SIZE}`, binds: [] },
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
				WHERE print_search MATCH ?1 ORDER BY ${order} LIMIT ${PAGE_SIZE}`,
			binds: [match]
		},
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
	const [rows, makes, uses, versions] = await db.batch<Record<string, unknown>>(
		[q.results, q.makes, q.uses, q.versions].map((st) => db.prepare(st.sql).bind(...st.binds))
	);
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
		facets: {
			makes: (makes.results ?? []) as { value: string; n: number }[],
			uses: (uses.results ?? []) as { value: string; n: number }[],
			versions: (versions.results ?? []) as { value: string; n: number }[]
		}
	};
};
