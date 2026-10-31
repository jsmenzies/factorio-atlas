/**
 * What the offline renders cover, for /admin/render: prints with a 2.0+ page (render_prints.modern),
 * the top-N most-favourited prints (render_favorites, migration 0014) and both together, each by
 * state, from render_jobs, prod uploads and the latest source check (render_source_changes). Also the Overview's coverage by the site each print is credited to. Pure
 * SQL and parsing, so the dashboard adds the statements to its one batch and tests can run them.
 */
import { siteOfPrintIdSql } from '#lib/print-id.js';

/** A print's state in a scope; each print has exactly one. */
export type ScopeState = 'rendered' | 'left' | 'failed' | 'none';

export interface ScopeFigures {
	/** Prints in the scope. */
	total: number;
	/** Every drawable page done (none pending or failed, at least one rendered). */
	rendered: number;
	/** Of those, every rendered page's current version is in the prod bucket. */
	uploaded: number;
	/** Pages pending or rendering, never queued (no rows), or (favourites) pages skipped as 'pre-2.0' by a run before the list. */
	left: number;
	/** Nothing to draw: every page modded, empty or undecodable. */
	none: number;
	/** A page failed (out of attempts, or its record is missing). */
	failed: number;
	/** The record file changed (or went) since a run looked at the print, at the latest source check. */
	updated: number;
}

export interface TopFigures extends ScopeFigures {
	/** Prints of the top list with a page saved in 2.0+, with none, and that no run has looked at yet. */
	modern: number;
	preModern: number;
	unseen: number;
}

export interface RenderScopes {
	modern: ScopeFigures;
	top: TopFigures;
	union: ScopeFigures;
	/** Favourites kept from earlier lists, out of the top N now: still in scope, not counted above. */
	former: number;
	/** The latest refresh and source check (render_meta), null before the first. */
	favorites: { n: number; source: string; prints: number; cutoff: number; refreshed_at: number; ms: number } | null;
	check: { source: string; compared: number; changed: number; gone: number; unseen: number; checked_at: number; ms: number } | null;
}

/**
 * Per print with render rows: its open, failed, done and old (pre-2.0 skipped) pages, the done pages' bytes, and
 * whether its record couldn't be decoded (one 'undecodable' row: never a print on the site). Grouped by print once
 * (render_jobs' primary key's order, no sort).
 */
const JOBS_CTE = `jobs AS (
	SELECT print_id,
		sum(status IN ('pending', 'rendering')) AS open,
		sum(status = 'failed') AS failed,
		sum(status = 'done') AS done,
		sum(status = 'done' AND uploaded_at IS NULL) AS not_up,
		sum(status = 'skipped' AND reason = 'pre-2.0') AS old,
		sum(CASE WHEN status = 'done' THEN bytes ELSE 0 END) AS bytes,
		sum(status = 'skipped' AND reason LIKE 'undecodable%') AS unreadable
	FROM render_jobs GROUP BY print_id
), members AS (
	SELECT print_id FROM render_prints WHERE modern = 1
	UNION SELECT print_id FROM render_favorites WHERE in_top = 1
)`;

/** A print's state as a 2.0+ print, and as a favourite (its pre-2.0 pages count as work), from `jobs` j. */
const STATE_MODERN = `CASE WHEN j.print_id IS NULL OR j.open > 0 THEN 'left' WHEN j.failed > 0 THEN 'failed' WHEN j.done > 0 THEN 'rendered' ELSE 'none' END`;
const STATE_TOP = `CASE WHEN j.print_id IS NULL OR j.open > 0 OR j.old > 0 THEN 'left' WHEN j.failed > 0 THEN 'failed' WHEN j.done > 0 THEN 'rendered' ELSE 'none' END`;

/**
 * One row per combination of scope membership and state, counted. render_jobs is grouped by print
 * once (its primary key's order, no sort); everything else is joined by primary key.
 */
const SCOPES_SQL = `WITH ${JOBS_CTE}
SELECT
	coalesce(p.modern, 0) AS modern,
	p.print_id IS NOT NULL AS seen,
	coalesce(f.in_top, 0) AS top,
	${STATE_MODERN} AS state_modern,
	${STATE_TOP} AS state_top,
	coalesce(j.done > 0 AND j.not_up = 0, 0) AS up,
	coalesce(c.print_id IS NOT NULL AND c.checked_at >= p.checked_at, 0) AS updated,
	count(*) AS n
FROM members m
LEFT JOIN render_prints p ON p.print_id = m.print_id
LEFT JOIN render_favorites f ON f.print_id = m.print_id
LEFT JOIN jobs j ON j.print_id = m.print_id
LEFT JOIN render_source_changes c ON c.print_id = m.print_id
GROUP BY 1, 2, 3, 4, 5, 6, 7`;

export const scopeStatements = (db: D1Database): D1PreparedStatement[] => [
	db.prepare(SCOPES_SQL),
	db.prepare('SELECT count(*) AS n FROM render_favorites WHERE in_top = 0'),
	db.prepare(`SELECT key, value FROM render_meta WHERE key IN ('favorites', 'source-check')`)
];

interface ScopeRow {
	modern: number;
	seen: number;
	top: number;
	state_modern: ScopeState;
	state_top: ScopeState;
	up: number;
	updated: number;
	n: number;
}

const empty = (): ScopeFigures => ({ total: 0, rendered: 0, uploaded: 0, left: 0, none: 0, failed: 0, updated: 0 });

const add = (f: ScopeFigures, state: ScopeState, r: ScopeRow) => {
	f.total += r.n;
	f[state] += r.n;
	if (state === 'rendered' && r.up) f.uploaded += r.n;
	if (r.updated) f.updated += r.n;
};

const parseMeta = <T>(value: string | undefined): T | null => {
	if (!value) return null;
	try {
		return JSON.parse(value) as T;
	} catch {
		return null;
	}
};

/** The statements' results (in order) as figures per scope. A favourite's state counts its pre-2.0 pages as work. */
export function parseScopes(results: { results?: unknown[] }[]): RenderScopes {
	const [groups, former, meta] = results;
	const modern = empty();
	const top: TopFigures = { ...empty(), modern: 0, preModern: 0, unseen: 0 };
	const union = empty();
	for (const r of (groups?.results ?? []) as ScopeRow[]) {
		if (r.modern) add(modern, r.state_modern, r);
		if (r.top) {
			add(top, r.state_top, r);
			if (!r.seen) top.unseen += r.n;
			else if (r.modern) top.modern += r.n;
			else top.preModern += r.n;
		}
		add(union, r.top ? r.state_top : r.state_modern, r);
	}
	const byKey = new Map(((meta?.results ?? []) as { key: string; value: string }[]).map((m) => [m.key, m.value]));
	return {
		modern,
		top,
		union,
		former: ((former?.results?.[0] as { n: number } | undefined)?.n ?? 0) as number,
		favorites: parseMeta(byKey.get('favorites')),
		check: parseMeta(byKey.get('source-check'))
	};
}

/**
 * Record-store prints (other sites, uploads) with a 2.0+ page, from sync_meta 'store-prints'
 * (scripts/render/store-scope.ts), against the render queue: `unseen`, never looked at (no render_prints row),
 * and `changed`, looked at but their record has changed since (another stamp). The coverage figures above count
 * only prints with a row, so without this the Update tab said "Nothing to render" while hundreds of codex and
 * fprints prints waited for their first render.
 */
export const STORE_WAITING_SQL = `SELECT
	coalesce(sum(p.print_id IS NULL), 0) AS unseen,
	coalesce(sum(p.print_id IS NOT NULL AND p.stamp IS NOT json_extract(s.value, '$[1]')), 0) AS changed
FROM json_each(coalesce((SELECT json_extract(value, '$.modern') FROM sync_meta WHERE key = 'store-prints'), '[]')) s
LEFT JOIN render_prints p ON p.print_id = json_extract(s.value, '$[0]')`;

/**
 * The coverage with the store's prints added: those never looked at are in scope and left (every 2.0+ print, and
 * the union), as a 2.0+ print with no rows is; changed ones count as `updated`, as a changed mirror record does.
 */
export const withStoreWaiting = (scopes: RenderScopes, store: { unseen: number; changed: number }): RenderScopes => {
	const add = (f: ScopeFigures): ScopeFigures => ({
		...f,
		total: f.total + store.unseen,
		left: f.left + store.unseen,
		updated: f.updated + store.changed
	});
	return { ...scopes, modern: add(scopes.modern), union: add(scopes.union) };
};

/**
 * Prints credited to another site than the one their id names (sync_meta 'figures' `credit`, read on the stage by
 * the figures step: a factorioprints id whose blueprint was posted first on codex, say). Empty before the first count.
 */
const CREDIT_CTE = `credit AS (
	SELECT key AS print_id, value AS site
	FROM json_each(coalesce((SELECT json_extract(value, '$.credit') FROM sync_meta WHERE key = 'figures'), '{}'))
)`;
const creditedSite = (col: string) => `coalesce(cr.site, ${siteOfPrintIdSql(col)})`;

/**
 * Render coverage by the site each print is credited to, for the Overview: every print the queue knows (in scope or
 * with pages drawn), its union state (a favourite's as a favourite), in scope unless its record couldn't be decoded
 * (those never became prints), with its drawn pages and their bytes. The same `jobs`, `members` and states as
 * SCOPES_SQL.
 */
export const SITE_SCOPES_SQL = `WITH ${JOBS_CTE}, ${CREDIT_CTE},
ids AS (SELECT print_id FROM members UNION SELECT print_id FROM jobs)
SELECT
	${creditedSite('i.print_id')} AS site,
	m.print_id IS NOT NULL AND coalesce(j.unreadable, 0) = 0 AS in_scope,
	CASE WHEN coalesce(f.in_top, 0) = 1 THEN ${STATE_TOP} ELSE ${STATE_MODERN} END AS state,
	count(*) AS n,
	coalesce(sum(j.done), 0) AS pages,
	coalesce(sum(j.bytes), 0) AS bytes
FROM ids i
LEFT JOIN members m ON m.print_id = i.print_id
LEFT JOIN render_favorites f ON f.print_id = i.print_id
LEFT JOIN jobs j ON j.print_id = i.print_id
LEFT JOIN credit cr ON cr.print_id = i.print_id
GROUP BY 1, 2, 3`;

/** STORE_WAITING_SQL by credited site. */
export const SITE_STORE_WAITING_SQL = `WITH ${CREDIT_CTE},
store AS (
	SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS stamp
	FROM json_each(coalesce((SELECT json_extract(value, '$.modern') FROM sync_meta WHERE key = 'store-prints'), '[]'))
)
SELECT
	${creditedSite('s.id')} AS site,
	coalesce(sum(p.print_id IS NULL), 0) AS unseen
FROM store s
LEFT JOIN render_prints p ON p.print_id = s.id
LEFT JOIN credit cr ON cr.print_id = s.id
GROUP BY 1`;

/** One site's render coverage (prints in scope by state, as `union`) and its drawn pages. */
export interface SiteRender {
	total: number;
	rendered: number;
	none: number;
	failed: number;
	left: number;
	/** Pages drawn, and their bytes on this machine (every print the queue drew, in scope or not). */
	pages: number;
	bytes: number;
}

const emptySite = (): SiteRender => ({ total: 0, rendered: 0, none: 0, failed: 0, left: 0, pages: 0, bytes: 0 });

/** SITE_SCOPES_SQL and SITE_STORE_WAITING_SQL's rows as figures by site; record-store prints never looked at are in scope and left. */
export function parseSiteScopes(scopes: { results?: unknown[] }, store: { results?: unknown[] }): Record<string, SiteRender> {
	const out: Record<string, SiteRender> = {};
	const at = (site: string) => (out[site] ??= emptySite());
	for (const r of (scopes.results ?? []) as {
		site: string;
		in_scope: number;
		state: ScopeState;
		n: number;
		pages: number;
		bytes: number;
	}[]) {
		const f = at(r.site);
		f.pages += r.pages;
		f.bytes += r.bytes;
		if (!r.in_scope) continue;
		f.total += r.n;
		f[r.state] += r.n;
	}
	for (const r of (store.results ?? []) as { site: string; unseen: number }[]) {
		if (!r.unseen) continue;
		const f = at(r.site);
		f.total += r.unseen;
		f.left += r.unseen;
	}
	return out;
}
