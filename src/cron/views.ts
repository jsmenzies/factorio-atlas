/**
 * The site's daily scheduled Worker. alchemy.run.ts deploys it as a Worker of its own (the site's
 * adapter-cloudflare Worker has no scheduled handler). Its jobs run one after another, each in its own
 * try, so one that fails never stops the others; the run throws at the end if any failed, so it shows as
 * an error in the Worker's logs, and the next day's run puts things right (every job is idempotent):
 *
 * 1. Reports: clears the contact and details of reports decided over 30 days ago (lib/server/reports.ts).
 * 2. Accounts' chores: expired sessions, old name holds, old upload counts (lib/server/auth/sessions.ts;
 *    logs its own failure and never throws).
 * 3. Views, behind the "Popular this month" sort: totals each print's page views over the last 30 days
 *    from the stage's Analytics Engine dataset and writes the counts that changed into D1's
 *    `prints.views_30d`, as `bun run views:sync` does by hand (lib/server/views.ts).
 * 4. Account deletions left part-way by their owners (lib/server/uploads/abandoned.ts), through the
 *    site's own gate and purge, so this Worker has the site's RAW, RENDERS and SCREENSHOTS buckets and its
 *    purge token. Last, so nothing waits on it; bounded in time and uploads, the rest the next day.
 */
import { accountChores } from '#lib/server/auth/sessions.js';
import { clearOldReportText } from '#lib/server/reports.js';
import { finishAbandonedDeletions } from '#lib/server/uploads/abandoned.js';
import { workerGate, type GateEnv } from '#lib/server/uploads/gate.js';
import { fetchViews, syncViews } from '#lib/server/views.js';

export interface ViewsCronEnv extends GateEnv {
	/** API token with Account Analytics: Read (a secret). */
	ANALYTICS_API_TOKEN: string;
	ACCOUNT_ID: string;
	/** viewsDataset(stage) in infra/databases.ts. */
	VIEWS_DATASET: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs the daily jobs (exported for tests); throws once all have run if any failed. */
export const dailyJobs = async (env: ViewsCronEnv) => {
	const failed: string[] = [];
	const job = async (name: string, run: () => Promise<void>) => {
		try {
			await run();
		} catch (e) {
			failed.push(name);
			console.error(`${name}: failed: ${message(e)}`);
		}
	};
	await job('reports', async () => {
		const cleared = await clearOldReportText(env.DB);
		console.log(`reports: contact and details cleared from ${cleared.meta.changes ?? 0} old reports`);
	});
	await accountChores(env.DB);
	await job('views', async () => {
		const wanted = await fetchViews({ accountId: env.ACCOUNT_ID, token: env.ANALYTICS_API_TOKEN, dataset: env.VIEWS_DATASET });
		const { plan, known, rowsWritten } = await syncViews(env.DB, wanted);
		console.log(
			`views: ${wanted.size} prints viewed (${known} ingested); ${plan.set.length} counts set, ${plan.clear.length} cleared, ${rowsWritten} rows written`
		);
	});
	await job('deletions', async () => {
		const r = await finishAbandonedDeletions({ db: env.DB, raw: env.RAW, gate: workerGate(env) });
		console.log(
			`deletions: ${r.due} accounts left deleting by their owners; ${r.finished} finished, ${r.uploads} uploads deleted, ${r.left} still deleting${r.failed ? ` (${r.failed} failed)` : ''}`
		);
	});
	if (failed.length) throw new Error(`daily jobs failed: ${failed.join(', ')}`);
};

export default {
	scheduled: (_controller, env) => dailyJobs(env)
} satisfies ExportedHandler<ViewsCronEnv>;
