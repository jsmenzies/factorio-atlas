/**
 * What the offline renders cover, for /admin/render: prints with a 2.0+ page (render_prints.modern),
 * the top-N most-favourited prints (render_favorites, migration 0014) and both together, each by
 * state, from render_jobs, prod uploads and the latest source check (render_source_changes). Pure
 * SQL and parsing, so the dashboard adds the statements to its one batch and tests can run them.
 */

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
 * One row per combination of scope membership and state, counted. render_jobs is grouped by print
 * once (its primary key's order, no sort); everything else is joined by primary key.
 */
const SCOPES_SQL = `WITH jobs AS (
	SELECT print_id,
		sum(status IN ('pending', 'rendering')) AS open,
		sum(status = 'failed') AS failed,
		sum(status = 'done') AS done,
		sum(status = 'done' AND uploaded_at IS NULL) AS not_up,
		sum(status = 'skipped' AND reason = 'pre-2.0') AS old
	FROM render_jobs GROUP BY print_id
), members AS (
	SELECT print_id FROM render_prints WHERE modern = 1
	UNION SELECT print_id FROM render_favorites WHERE in_top = 1
)
SELECT
	coalesce(p.modern, 0) AS modern,
	p.print_id IS NOT NULL AS seen,
	coalesce(f.in_top, 0) AS top,
	CASE WHEN j.print_id IS NULL OR j.open > 0 THEN 'left' WHEN j.failed > 0 THEN 'failed' WHEN j.done > 0 THEN 'rendered' ELSE 'none' END AS state_modern,
	CASE WHEN j.print_id IS NULL OR j.open > 0 OR j.old > 0 THEN 'left' WHEN j.failed > 0 THEN 'failed' WHEN j.done > 0 THEN 'rendered' ELSE 'none' END AS state_top,
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
