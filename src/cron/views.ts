/**
 * The scheduled Worker behind the "Popular this month" sort: once a day it totals each print's page
 * views over the last 30 days from the stage's Analytics Engine dataset and writes the counts that
 * changed into D1's `prints.views_30d`, as `bun run views:sync` does by hand (lib/server/views.ts).
 * alchemy.run.ts deploys it as a Worker of its own (the site's adapter-cloudflare Worker has no
 * scheduled handler). A failed run throws, so it shows as an error in the Worker's logs, and the
 * next day's run puts everything right: the sync writes the whole difference.
 *
 * It also clears the contact and details of reports decided over 30 days ago (lib/server/reports.ts),
 * first, so a failed views sync doesn't hold it up; its own failure is logged and doesn't hold up the
 * views sync either (the next day's run clears what this one missed). So do the accounts' chores
 * (expired sessions, old name holds, old upload counts: lib/server/auth/sessions.ts), which never throw.
 */
import { accountChores } from '#lib/server/auth/sessions.js';
import { clearOldReportText } from '#lib/server/reports.js';
import { fetchViews, syncViews } from '#lib/server/views.js';

export interface ViewsCronEnv {
	DB: D1Database;
	/** API token with Account Analytics: Read (a secret). */
	ANALYTICS_API_TOKEN: string;
	ACCOUNT_ID: string;
	/** viewsDataset(stage) in infra/databases.ts. */
	VIEWS_DATASET: string;
}

export default {
	async scheduled(_controller, env) {
		try {
			const cleared = await clearOldReportText(env.DB);
			console.log(`reports: contact and details cleared from ${cleared.meta.changes ?? 0} old reports`);
		} catch (e) {
			console.error(`reports: clearing old contacts failed: ${e instanceof Error ? e.message : String(e)}`);
		}
		await accountChores(env.DB);
		const wanted = await fetchViews({ accountId: env.ACCOUNT_ID, token: env.ANALYTICS_API_TOKEN, dataset: env.VIEWS_DATASET });
		const { plan, known, rowsWritten } = await syncViews(env.DB, wanted);
		console.log(
			`views: ${wanted.size} prints viewed (${known} ingested); ${plan.set.length} counts set, ${plan.clear.length} cleared, ${rowsWritten} rows written`
		);
	}
} satisfies ExportedHandler<ViewsCronEnv>;
