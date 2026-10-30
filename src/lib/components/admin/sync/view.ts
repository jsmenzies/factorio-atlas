import type { ScopeFigures } from '#lib/server/admin/render-scope.js';
import {
	estimateRender,
	planTotals,
	sourceMoved,
	SYNC_STALE_MS,
	type SourcePlan,
	type StepStatus,
	type SyncPlan,
	type SyncRun,
	type SyncSettings,
	type SyncStepId
} from '#lib/sync.js';
import { int, isLiveState } from '../metrics.js';

/**
 * What the update box shows: an update running (or one that stopped beating: crashed), a source
 * held back (its fetch skipped until accepted; the other steps still run), something new waiting,
 * or nothing new.
 */
export type UpdateState = 'running' | 'crashed' | 'blocked' | 'waiting' | 'current';

/** Sources the fetch would hold back. */
export const heldBack = (plan: SyncPlan | null): SourcePlan[] => (plan?.sources ?? []).filter((p) => p.blocked);

export const updateState = (run: SyncRun | null, plan: SyncPlan | null, now: number): UpdateState => {
	if (run && isLiveState(run.state)) return now - run.updated_at > SYNC_STALE_MS ? 'crashed' : 'running';
	if (heldBack(plan).length) return 'blocked';
	if (planTotals(plan).moved) return 'waiting';
	return 'current';
};

/** The mirror's plan (the first source today), for the lines that name its commits. */
export const mirrorPlan = (plan: SyncPlan | null) => plan?.sources[0] ?? null;

/**
 * A source's line in the Overview's list: held back, behind (and by how much), or up to date. A source
 * whose cursor isn't a commit (uploads) says what waits in its own words (`stateText`).
 */
export const sourceState = (p: SourcePlan): { text: string; tone: 'ok' | 'warn' | 'bad' } => {
	if (p.error) return { text: 'couldn’t check', tone: 'bad' };
	if (p.blocked) return { text: 'held back', tone: 'bad' };
	if (!sourceMoved(p)) return { text: 'up to date', tone: 'ok' };
	if (p.stateText) return { text: p.stateText, tone: 'warn' };
	const behind = p.behind ? `${int(p.behind)} commit${p.behind === 1 ? '' : 's'} behind` : 'behind';
	return { text: `${behind} · ${int(p.added)} new, ${int(p.edited)} edited`, tone: 'warn' };
};

export { sourceMoved };

/** A mirror check older than this is redone when the Overview opens. */
export const PLAN_FRESH_MS = 10 * 60_000;

export const STEP_MARK: Record<StepStatus, { mark: string; class: string; label: string }> = {
	pending: { mark: '', class: 'border border-stone-700 text-stone-400', label: 'Waiting' },
	running: { mark: '', class: 'bg-amber-500/15 text-amber-300', label: 'Running' },
	done: { mark: '✓', class: 'bg-emerald-950 text-emerald-300', label: 'Done' },
	warning: { mark: '!', class: 'bg-amber-950 text-amber-200', label: 'Done, with something to look at' },
	failed: { mark: '✗', class: 'bg-rose-950 text-rose-300', label: 'Failed' },
	skipped: { mark: '·', class: 'border border-dashed border-stone-700 text-stone-500', label: 'Skipped' },
	stopped: { mark: '■', class: 'border border-dashed border-stone-700 text-stone-500', label: 'Not run: stopped' }
};

/** How many prints the render step would take on: new and edited prints with a 2.0+ page, and what's left in scope, up to the per-update limit. */
export const renderWork = (plan: SyncPlan | null, left: number, settings: SyncSettings) => {
	const wanted = planTotals(plan).modern + left;
	return settings.perUpdate === null ? wanted : Math.min(wanted, settings.perUpdate);
};

export interface PreviewStep {
	id: SyncStepId;
	text: string;
	/** Off in the settings, or nothing to do. */
	idle?: boolean;
}

/** What each step would do in an update started now, from the last mirror check and the coverage figures. */
export function previewSteps(plan: SyncPlan | null, union: ScopeFigures, settings: SyncSettings): PreviewStep[] {
	const t = planTotals(plan);
	const moved = t.moved;
	const held = heldBack(plan);
	const prints = renderWork(plan, union.left, settings);
	const capped = settings.perUpdate !== null && prints === settings.perUpdate;
	// Uploads waiting are admitted in the fetch step (their own source), never by the ingest step's backfill.
	const fetches = [
		...(t.backfill
			? [`+${int(t.added)} new, ${int(t.edited)} edited, ${int(t.favourites)} only favourite counts changed, ${int(t.deleted)} deleted`]
			: []),
		...(plan?.sources ?? [])
			.filter((p) => p.ingestsItself && sourceMoved(p) && !p.blocked)
			.map((p) => `${p.site}: ${p.stateText ?? 'something waiting'}`)
	];
	return [
		{ id: 'removals', text: "sweep this machine's copies of prints removed on the site (renders, thumbnails, screenshots)" },
		{
			id: 'fetch',
			text:
				(moved ? fetches.join('; ') : 'nothing new to fetch') + (held.length ? `; ${held.map((p) => p.site).join(', ')} held back` : ''),
			idle: !moved
		},
		{
			id: 'ingest',
			text: t.backfill
				? `analyse ${int(t.added + t.edited)} new and edited prints; ${int(t.favourites)} favourite counts are one row each`
				: 'skipped when nothing changed since the last update that ran it',
			idle: !t.backfill
		},
		settings.authors
			? { id: 'authors', text: `their records first, then Firebase for up to ${int(settings.authorLimit)}` }
			: { id: 'authors', text: 'off in the settings', idle: true },
		settings.screenshots
			? {
					id: 'screenshots',
					text:
						(t.backfill ? `copy up to ${int(t.added)} new screenshots from Imgur, upload them` : 'copy any new screenshots from Imgur') +
						(settings.imgurRecheck === 'weekly' ? '; recheck Imgur for deletions if a week has passed' : '')
				}
			: { id: 'screenshots', text: 'off in the settings', idle: true },
		{
			id: 'render',
			text:
				(settings.top > 0 ? `refresh the top ${int(settings.top)} favourites, look for changed records; ` : 'look for changed records; ') +
				(prints
					? `render about ${int(prints)} prints${capped ? ` (the per-update limit)` : ''}: new 2.0+ prints and what's left in scope; then thumbnails, the render filter and the page cache`
					: 'nothing to render, unless the top list or changed records add some'),
			idle: !prints
		},
		{ id: 'figures', text: "count the site's prints, renders and screenshots" }
	];
}

/** Time, uploads and disk for the render step of an update started now. */
export const previewCost = (plan: SyncPlan | null, union: ScopeFigures, settings: SyncSettings) =>
	estimateRender(renderWork(plan, union.left, settings));

export const shortCommit = (commit: string | null | undefined) => commit?.slice(0, 7) ?? '?';
