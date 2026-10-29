/**
 * The admin Overview (local only): the latest updates (`sync_runs`), the saved settings, the last
 * mirror check and stage figures (`sync_meta`), render coverage and the render queue's totals, in
 * one `db.batch` (see busy.ts for why one).
 */
import { LIVE_STATES } from '#lib/server/pipeline/runs.js';
import { RENDER_STALE_MS, type RenderRunRow } from '#lib/server/render-queue.js';
import {
	parseSettings,
	parseSyncRun,
	SYNC_HEARTBEAT_MS,
	SYNC_STALE_MS,
	type SyncFigures,
	type SyncPlan,
	type SyncRun,
	type SyncRunRow
} from '#lib/sync.js';
import { parseRenderRun, type RenderRun } from './render.js';
import { parseScopes, scopeStatements } from './render-scope.js';

export const SYNC_RUNS_SHOWN = 10;

export interface RenderTotals {
	/** Rendered pages, their bytes on disk, and how many of them are in the prod bucket. */
	pages: number;
	bytes: number;
	uploaded: number;
	failed: number;
}

const meta = <T>(rows: { key: string; value: string; updated_at: number }[], key: string) => {
	const row = rows.find((r) => r.key === key);
	return row ? { value: JSON.parse(row.value) as T, updatedAt: row.updated_at } : null;
};

export const syncOverview = async (db: D1Database, now = Date.now()) => {
	const scopes = scopeStatements(db);
	const results = await db.batch([
		db.prepare('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?').bind(SYNC_RUNS_SHOWN),
		db.prepare('SELECT key, value, updated_at FROM sync_meta'),
		db.prepare(
			`SELECT count(*) AS pages, coalesce(sum(bytes), 0) AS bytes, count(uploaded_at) AS uploaded,
			(SELECT count(*) FROM render_jobs WHERE status = 'failed') AS failed
			FROM render_jobs WHERE status = 'done'`
		),
		// The render run an update's render step is on, or one started by hand, for its progress.
		db
			.prepare(
				`SELECT * FROM render_runs WHERE state IN (${LIVE_STATES.map(() => '?').join(', ')}) AND updated_at > ? ORDER BY started_at DESC LIMIT 1`
			)
			.bind(...LIVE_STATES, now - RENDER_STALE_MS),
		...scopes
	]);
	const [runRows, metaRows, totals, liveRender, ...scopeResults] = results;
	const runs: SyncRun[] = (runRows.results as SyncRunRow[]).map(parseSyncRun);
	const m = metaRows.results as { key: string; value: string; updated_at: number }[];
	const stored = meta<unknown>(m, 'settings');
	const render = (liveRender.results as RenderRunRow[])[0];
	return {
		runs,
		settings: parseSettings(stored?.value).settings,
		settingsSavedAt: stored?.updatedAt ?? null,
		plan: meta<SyncPlan>(m, 'plan'),
		figures: meta<SyncFigures>(m, 'figures'),
		totals: totals.results[0] as unknown as RenderTotals,
		liveRender: render ? (parseRenderRun({ ...render, options: '{}' }) as RenderRun) : null,
		scopes: parseScopes(scopeResults)
	};
};

export const SYNC_TIMING = { staleMs: SYNC_STALE_MS, heartbeatMs: SYNC_HEARTBEAT_MS };

/**
 * A form post from another site. SvelteKit skips its own CSRF check under `vite dev`, the only place
 * the Overview and Settings actions exist, so they check the Origin header themselves.
 */
export const crossSite = (request: Request, url: URL) => {
	const origin = request.headers.get('origin');
	return origin !== null && origin !== url.origin;
};
