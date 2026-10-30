/**
 * Account deletions left part-way. Deleting an account runs about 15 s of its uploads per request from
 * the account page, which asks again until none are left; an owner who closes the page and never signs in
 * again leaves the account `deleting_at` with uploads still live. The daily cron Worker (src/cron/views.ts)
 * finishes them through the owner's own path (uploads.ts deleteAccountStep), oldest deletion first:
 *
 * - only accounts whose deletion started over DELETION_GRACE_MS ago, so it never works beside an owner's
 *   page that is still going (each step is idempotent, so a race would only repeat work);
 * - at most CRON_DELETE_MAX_UPLOADS uploads and CRON_DELETE_BUDGET_MS a run (one upload is about 20 D1 and
 *   R2 calls; a cron invocation may make 10,000 and run 15 minutes), the rest the next day;
 * - one account that fails is logged and the others go on.
 */
import { deleteAccountStep, type UploadDeps } from './uploads.js';

/** How long after its owner started a deletion the cron may finish it. */
export const DELETION_GRACE_MS = 60 * 60_000;
/** Time one cron run spends deleting uploads. */
export const CRON_DELETE_BUDGET_MS = 5 * 60_000;
/** Uploads one cron run tries at most (≈ 4,000 subrequests). */
export const CRON_DELETE_MAX_UPLOADS = 200;
/** Accounts one run looks at; ones with no uploads left cost two D1 calls each. */
const ACCOUNTS_PER_RUN = 100;

export interface AbandonedResult {
	/** Accounts due (deleting for longer than the grace), up to ACCOUNTS_PER_RUN. */
	due: number;
	/** Accounts deleted for good this run. */
	finished: number;
	/** Uploads deleted this run. */
	uploads: number;
	/** Accounts due that are still deleting: out of time or uploads this run, or one failed. */
	left: number;
	/** Accounts whose step threw. */
	failed: number;
}

export const finishAbandonedDeletions = async (
	deps: Pick<UploadDeps, 'db' | 'raw' | 'gate'>,
	{
		now = Date.now(),
		clock = Date.now,
		graceMs = DELETION_GRACE_MS,
		budgetMs = CRON_DELETE_BUDGET_MS,
		maxUploads = CRON_DELETE_MAX_UPLOADS
	}: { now?: number; clock?: () => number; graceMs?: number; budgetMs?: number; maxUploads?: number } = {}
): Promise<AbandonedResult> => {
	const started = clock();
	const due = (
		await deps.db
			.prepare(
				`SELECT a.id, (SELECT count(*) FROM uploads u WHERE u.user_id = a.id) AS uploads FROM users a
				WHERE a.deleting_at IS NOT NULL AND a.deleting_at <= ? ORDER BY a.deleting_at, a.id LIMIT ?`
			)
			.bind(now - graceMs, ACCOUNTS_PER_RUN)
			.all<{ id: string; uploads: number }>()
	).results;
	const result: AbandonedResult = { due: due.length, finished: 0, uploads: 0, left: 0, failed: 0 };
	let uploadsLeft = maxUploads;
	for (const account of due) {
		const remainingMs = budgetMs - (clock() - started);
		if (remainingMs <= 0 || (account.uploads > 0 && uploadsLeft <= 0)) {
			result.left++;
			continue;
		}
		try {
			const step = await deleteAccountStep(deps, account.id, { budgetMs: remainingMs, clock, maxUploads: uploadsLeft });
			result.uploads += step.deleted;
			if (step.done) result.finished++;
			else result.left++;
		} catch (e) {
			result.failed++;
			result.left++;
			console.error(
				`accounts: finishing the deletion of ${account.id} failed, left for the next run: ${e instanceof Error ? e.message : e}`
			);
		}
		// What this account may have used of the run's bound (failed uploads count too).
		uploadsLeft -= Math.min(account.uploads, uploadsLeft);
	}
	return result;
};
