import type { ScopeFigures } from '#lib/server/admin/render-scope.js';
import {
	detail,
	estimateRender,
	planTotals,
	POLLED_READS_PER_UPDATE,
	sourceMoved,
	SYNC_STALE_MS,
	type DetailGroup,
	type DetailRow,
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

/** Sources the last check couldn't reach (an error): never "up to date". */
export const unchecked = (plan: SyncPlan | null): SourcePlan[] => (plan?.sources ?? []).filter((p) => p.error);

/**
 * The headline when nothing waits: every source on is up to date, or how many are and which couldn't be
 * checked ("2 of 3 sources up to date · codex couldn't be checked"). Sources turned off aren't counted.
 */
export const upToDateLine = (plan: SyncPlan): { text: string; complete: boolean } => {
	const on = plan.sources.filter((p) => !p.off);
	const failed = unchecked(plan);
	// complete: the text follows the words "Up to date", which the box sets in green.
	if (!failed.length) return { text: on.length === 1 ? 'with its source' : `with all ${on.length} sources`, complete: true };
	const ok = on.length - failed.length;
	return { text: `${ok} of ${on.length} source${on.length === 1 ? '' : 's'} up to date · ${uncheckedText(failed)}`, complete: false };
};

/** "codex couldn't be checked", "codex and fprints couldn't be checked". */
export const uncheckedText = (failed: readonly SourcePlan[]) => {
	const names = failed.map((p) => p.site);
	const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
	return `${list} couldn’t be checked`;
};

/** The mirror's plan (the first source today), for the lines that name its commits. */
export const mirrorPlan = (plan: SyncPlan | null) => plan?.sources[0] ?? null;

/**
 * A source's line in the Overview's list: held back, behind (and by how much), or up to date. A source
 * whose cursor isn't a commit (uploads) says what waits in its own words (`stateText`).
 */
export const sourceState = (p: SourcePlan): { text: string; tone: 'ok' | 'warn' | 'bad' | 'off' } => {
	if (p.off) return { text: 'off', tone: 'off' };
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
			.filter((p) => (p.ingestsItself || p.polled) && sourceMoved(p) && !p.blocked)
			.map(
				(p) =>
					`${p.site}: ${p.stateText ?? 'something waiting'}${p.polled ? ` (≈ ${int(Math.min(p.added + p.edited + p.deleted.length, POLLED_READS_PER_UPDATE))} reads at 1 a second)` : ''}`
			)
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
			text:
				(t.backfill
					? `analyse ${int(t.added + t.edited)} new and edited prints; ${int(t.favourites)} favourite counts are one row each`
					: 'skipped when nothing changed since the last update that ran it') +
				(t.polled ? `; then admit ${int(t.polled)} records from other sites through the gate` : ''),
			idle: !t.backfill && !t.polled
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
		!settings.render
			? { id: 'render', text: 'off in the settings', idle: true }
			: {
					id: 'render',
					text:
						(settings.top > 0
							? `refresh the top ${int(settings.top)} favourites, look for changed records; `
							: 'look for changed records; ') +
						(prints
							? `render about ${int(prints)} prints${capped ? ` (the per-update limit)` : ''}: new 2.0+ prints and what's left in scope, other sites' and uploads included; then thumbnails, the render filter and the page cache`
							: 'nothing to render, unless the top list or changed records add some'),
					idle: !prints
				},
		{ id: 'figures', text: "count the site's prints, renders and screenshots" }
	];
}

/** Time, uploads and disk for the render step of an update started now (nothing when it's off). */
export const previewCost = (plan: SyncPlan | null, union: ScopeFigures, settings: SyncSettings) =>
	estimateRender(settings.render ? renderWork(plan, union.left, settings) : 0);

const groupOf = (run: SyncRun, step: SyncStepId, match: (title: string) => boolean): DetailGroup | undefined =>
	run.steps.find((s) => s.id === step)?.details?.find((g) => g.title !== undefined && match(g.title));
const valueOf = (g: DetailGroup | undefined, label: string) => {
	const v = g?.rows.find((r) => r.label === label)?.value;
	return typeof v === 'number' ? v : undefined;
};

/**
 * What one update did for one source, for its card on the Update tab: a polled site's reads (from its
 * `counts`) and how they went through the gate (the ingest step's "<site>: through the gate" group); the
 * mirror's fetch rows and the backfill's analysed/failed; any other source its fetch group as recorded.
 * Empty until the fetch step has recorded something for it.
 */
export function sourceRunRows(run: SyncRun, site: string): DetailRow[] {
	const entry = run.sources.find((s) => s.site === site);
	const fetched = groupOf(run, 'fetch', (t) => t === site);
	if (entry?.polled) {
		const c = entry.counts;
		if (!c) return [];
		const gate = groupOf(run, 'ingest', (t) => t === `${site}: through the gate`);
		const gateFailed = valueOf(gate, 'failed, tried again next update') ?? 0;
		return [
			...detail('read', c['records read'], { always: true }),
			...detail('new', c.new),
			...detail('changed', c.changed),
			...detail('new prints on the site', valueOf(gate, 'new prints')),
			...detail('joined an existing print', valueOf(gate, 'joined an existing print')),
			...detail('updated', valueOf(gate, 'updated')),
			...detail('gone from the site', c['gone from the site'], { tone: 'warn' }),
			...detail('failed', (c.failed ?? 0) + gateFailed, { always: true, tone: 'bad' }),
			...detail('left for the next update', c.left, { always: true, tone: 'warn' })
		];
	}
	if (!fetched) return [];
	if (entry && !entry.ingestsItself) {
		// The backfill's group names every site it read ("factorioprints, codex, fprints").
		const backfill = groupOf(run, 'ingest', (t) => !t.includes(':') && t.split(', ').includes(site));
		return [
			...fetched.rows.filter((r) => r.label !== 'position'),
			...detail('analysed', valueOf(backfill, 'analysed')),
			...detail('re-indexed', valueOf(backfill, 're-indexed')),
			...detail('failed to read', valueOf(backfill, 'failed'), { tone: 'bad' })
		];
	}
	return fetched.rows;
}

export const shortCommit = (commit: string | null | undefined) => commit?.slice(0, 7) ?? '?';
