/**
 * Print page views, for the search page's "Popular" sort. Light on purpose: the print page sends one
 * keepalive fetch when it mounts (so hover preloads, which run its load, and most crawlers never
 * count), the Worker writes one Analytics Engine data point holding only the print id (no IP, user
 * agent or cookie), and once a day src/cron/views.ts (or `bun run views:sync` by hand) totals the
 * last VIEW_DAYS days per print into `prints.views_30d` (migration 0016). Counts are approximate: Analytics Engine samples at high
 * volume, and nothing stops a visitor reloading beyond the page's per-tab dedupe and the rate limits.
 */

/** factorioprints ids: 20 characters of Firebase's push-id alphabet. */
export const PRINT_ID = /^[A-Za-z0-9_-]{20}$/;

/** User agents that announce a crawler, preview fetcher or headless browser. */
const BOT = /bot|crawl|spider|slurp|preview|headless|lighthouse|python|curl|wget|httpclient|fetch/i;

export const isBot = (userAgent: string | null) => !userAgent || BOT.test(userAgent);

/** The part of an Analytics Engine binding used here. */
export interface ViewDataset {
	writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

/**
 * Count one view of `id`, unless the request looks automated. The print id is the data point's
 * index, so Analytics Engine samples per print and `_sample_interval` sums back to a count.
 */
export const recordView = (dataset: ViewDataset | undefined, id: string, userAgent: string | null): boolean => {
	if (!dataset || !PRINT_ID.test(id) || isBot(userAgent)) return false;
	dataset.writeDataPoint({ indexes: [id] });
	return true;
};

/** The window `views_30d` covers. */
export const VIEW_DAYS = 30;

/** Views per print over the last VIEW_DAYS days, highest first, for the Analytics Engine SQL API. */
export const viewsQuery = (dataset: string, limit: number) => {
	if (!/^\w+$/.test(dataset)) throw new Error(`not a dataset name: ${dataset}`);
	return `SELECT index1 AS id, SUM(_sample_interval) AS views FROM ${dataset}
	WHERE timestamp > NOW() - INTERVAL '${VIEW_DAYS}' DAY
	GROUP BY index1 ORDER BY views DESC LIMIT ${limit} FORMAT JSON`;
};

/**
 * The query's rows as print id → views, keeping only well-formed ids and positive counts. Numbers may
 * arrive as strings (64-bit integers in JSON). Pure.
 */
export const parseViews = (body: unknown): Map<string, number> => {
	const data = (body as { data?: { id?: unknown; views?: unknown }[] } | null)?.data;
	if (!Array.isArray(data)) throw new Error(`unexpected Analytics Engine response: ${JSON.stringify(body).slice(0, 300)}`);
	const out = new Map<string, number>();
	for (const row of data) {
		const views = Math.round(Number(row.views));
		if (typeof row.id === 'string' && PRINT_ID.test(row.id) && views > 0) out.set(row.id, views);
	}
	return out;
};

/** Rows the sync asks for; more than there are prints, so in practice the whole tail. */
export const QUERY_LIMIT = 100_000;

/** Views per print from a stage's dataset, through the SQL API (needs an Account Analytics: Read token). */
export const fetchViews = async (opts: { accountId: string; token: string; dataset: string; fetch?: typeof fetch }) => {
	const res = await (opts.fetch ?? fetch)(`https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/analytics_engine/sql`, {
		method: 'POST',
		headers: { authorization: `Bearer ${opts.token}` },
		body: viewsQuery(opts.dataset, QUERY_LIMIT)
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`Analytics Engine SQL API answered ${res.status}: ${text.slice(0, 500)}`);
	const views = parseViews(JSON.parse(text));
	if (views.size >= QUERY_LIMIT) throw new Error(`the query hit its limit of ${QUERY_LIMIT} rows; raise QUERY_LIMIT`);
	return views;
};

export interface ViewsPlan {
	/** [print id, views] for prints whose count changes to a positive number. */
	set: [string, number][];
	/** Prints with a count now and no views in the window: back to 0. */
	clear: string[];
}

/** The writes that bring `current` (prints with views_30d > 0) to `wanted`. Pure. */
export const planViews = (wanted: Map<string, number>, current: Map<string, number>): ViewsPlan => ({
	set: [...wanted].filter(([id, n]) => n > 0 && current.get(id) !== n).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	clear: [...current.keys()].filter((id) => !wanted.has(id)).sort()
});

/** Prints with views_30d > 0 (read through the prints_views index). */
export const loadViews = async (db: D1Database) => {
	const { results } = await db.prepare('SELECT id, views_30d FROM prints WHERE views_30d > 0').all<{ id: string; views_30d: number }>();
	return new Map(results.map((r) => [r.id, r.views_30d]));
};

const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** The plan as D1 statements, each with at most 98 bound parameters. Prints not ingested here are left alone. */
export const viewsStatements = (db: D1Database, plan: ViewsPlan): D1PreparedStatement[] => [
	...chunks(plan.set, 49).map((c) =>
		db
			.prepare(
				`UPDATE prints SET views_30d = v.column2 FROM (VALUES ${c.map(() => '(?, ?)').join(', ')}) AS v
				WHERE prints.id = v.column1 AND prints.views_30d != v.column2`
			)
			.bind(...c.flat())
	),
	...chunks(plan.clear, 98).map((c) =>
		db.prepare(`UPDATE prints SET views_30d = 0 WHERE id IN (${c.map(() => '?').join(', ')})`).bind(...c)
	)
];

export interface ViewsSyncResult {
	plan: ViewsPlan;
	/** Of the prints with views, those ingested in this stage. */
	known: number;
	rowsWritten: number;
}

/** Bring a stage's `views_30d` in line with `wanted`, in D1 batches; `dryRun` only plans. Idempotent. */
export const syncViews = async (
	db: D1Database,
	wanted: Map<string, number>,
	options: { dryRun?: boolean; batchSize?: number; onBatch?: (done: number, total: number) => void } = {}
): Promise<ViewsSyncResult> => {
	const current = await loadViews(db);
	const plan = planViews(wanted, current);
	const size = options.batchSize ?? 50;
	const counts = chunks([...wanted.keys()], 98).map((ids) =>
		db.prepare(`SELECT COUNT(*) AS n FROM prints WHERE id IN (${ids.map(() => '?').join(', ')})`).bind(...ids)
	);
	let known = 0;
	for (let i = 0; i < counts.length; i += size) {
		for (const r of await db.batch<{ n: number }>(counts.slice(i, i + size))) known += r.results?.[0]?.n ?? 0;
	}
	let rowsWritten = 0;
	if (!options.dryRun) {
		const stmts = viewsStatements(db, plan);
		for (let i = 0; i < stmts.length; i += size) {
			const results = await db.batch(stmts.slice(i, i + size));
			rowsWritten += results.reduce((n, r) => n + (r.meta?.rows_written ?? 0), 0);
			options.onBatch?.(Math.min(i + size, stmts.length), stmts.length);
		}
	}
	return { plan, known, rowsWritten };
};
