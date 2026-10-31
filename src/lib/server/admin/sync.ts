/**
 * The admin Overview and Update tabs (local only): the latest updates (`sync_runs`), the saved settings, the last
 * mirror check and stage figures (`sync_meta`), render coverage (also by credited site) and the render queue's totals, in
 * one `db.batch` (see busy.ts for why one).
 */
import { LIVE_STATES } from '#lib/server/pipeline/runs.js';
import { parseStages } from '#lib/render-stages.js';
import { RENDER_STALE_MS, type RenderRunPhase, type RenderRunRow } from '#lib/server/render-queue.js';
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
import type { RenderRun } from './render.js';
import {
	parseScopes,
	parseSiteScopes,
	scopeStatements,
	SITE_SCOPES_SQL,
	SITE_STORE_WAITING_SQL,
	STORE_WAITING_SQL,
	withStoreWaiting
} from './render-scope.js';

export const SYNC_RUNS_SHOWN = 10;

/** render_runs' columns but `options`. */
const RENDER_COLUMNS = `id, host, source, state, control, total, done, rendered, unchanged, skipped, failed, files, bytes, rate,
	eta_seconds, started_at, updated_at, finished_at, error, upload_target, uploaded, upload_files, upload_bytes, upload_deleted,
	uploads_pending, upload_failed, upload_error, upload_deletes_pending, prints_total, prints_done, prints_rendered,
	upload_rate_bytes, upload_rate_files, upload_rate_pages`;

const RENDER_SELECT = `SELECT ${RENDER_COLUMNS}, json_extract(options, '$.phase') AS phase,
	json_extract(options, '$.stages') AS stages FROM render_runs`;

type LatestRenderRow = Omit<RenderRunRow, 'options'> & { phase: string | null; stages: string | null };

/** A render run with only the options the Update tab reads. */
const renderOf = ({ phase, stages, ...row }: LatestRenderRow): RenderRun => ({
	...row,
	options: {
		phase: (phase as RenderRunPhase | null) ?? null,
		stages: parseStages(stages)
	}
});

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
		// The live render run, if any (an update's render step, or one started by hand), and the latest one, live or
		// not (render_runs_started): a newer row can be a second start that failed at once while the first still runs.
		// Only the options the page reads: a batch's picks can be thousands of ids.
		db
			.prepare(
				`${RENDER_SELECT} WHERE state IN (${LIVE_STATES.map(() => '?').join(', ')}) AND updated_at > ? ORDER BY started_at DESC LIMIT 1`
			)
			.bind(...LIVE_STATES, now - RENDER_STALE_MS),
		db.prepare(`${RENDER_SELECT} ORDER BY started_at DESC LIMIT 1`),
		db.prepare(STORE_WAITING_SQL),
		db.prepare(SITE_SCOPES_SQL),
		db.prepare(SITE_STORE_WAITING_SQL),
		...scopes
	]);
	const [runRows, metaRows, totals, liveRender, latestRender, storeWaiting, siteScopes, siteStore, ...scopeResults] = results;
	const store = storeWaiting.results[0] as { unseen?: number; changed?: number } | undefined;
	const waiting = { unseen: Number(store?.unseen ?? 0), changed: Number(store?.changed ?? 0) };
	const runs: SyncRun[] = (runRows.results as SyncRunRow[]).map(parseSyncRun);
	const m = metaRows.results as { key: string; value: string; updated_at: number }[];
	const stored = meta<unknown>(m, 'settings');
	const latestRow = (latestRender.results as LatestRenderRow[])[0];
	const liveRow = (liveRender.results as LatestRenderRow[])[0];
	const render = latestRow ? renderOf(latestRow) : null;
	const live = liveRow ? renderOf(liveRow) : null;
	return {
		runs,
		settings: parseSettings(stored?.value).settings,
		settingsSavedAt: stored?.updatedAt ?? null,
		plan: meta<SyncPlan>(m, 'plan'),
		figures: meta<SyncFigures>(m, 'figures'),
		totals: totals.results[0] as unknown as RenderTotals,
		/** The render run that is live now (beating within RENDER_STALE_MS), if any. */
		liveRender: live,
		/** The latest render run, live or not: an update's board reads its stages until the step records them. */
		latestRender: render,
		/** Record-store prints never rendered (already in `scopes`' total and left) and changed since (in `updated`). */
		storeWaiting: waiting,
		scopes: withStoreWaiting(parseScopes(scopeResults), waiting),
		/** Render coverage and drawn pages by the site prints are credited to (the Overview's table). */
		siteRender: parseSiteScopes(siteScopes, siteStore)
	};
};

export const SYNC_TIMING = { staleMs: SYNC_STALE_MS, heartbeatMs: SYNC_HEARTBEAT_MS };

/**
 * A form post from another site. SvelteKit skips its own CSRF check under `vite dev`, the only place
 * the Update tab's actions exist, so they check the Origin header themselves.
 */
export const crossSite = (request: Request, url: URL) => {
	const origin = request.headers.get('origin');
	return origin !== null && origin !== url.origin;
};
