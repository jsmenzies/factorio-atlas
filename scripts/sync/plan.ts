/**
 * The sources' plans as the fetch step saves them (sync_meta 'plan', what the Overview shows): one entry per
 * source, a source whose plan failed included with its error (so the Overview never calls it up to date), and
 * after the fetch the fetched sources level at their new cursors. Pure; sync.ts runs it.
 */
import type { SourceCursor, SourcePlan, SourceRun } from '#lib/sync.js';
import type { SourceAdapter } from './mirror';

const n = (x: number) => x.toLocaleString('en-US');

/** The plan of a source that couldn't be checked: nothing new, its kind kept for the Overview's list, and why. */
export const failedPlan = (s: Pick<SourceAdapter, 'site' | 'kind' | 'polled' | 'ingestsItself'>, error: string): SourcePlan => {
	const none: SourceCursor = { id: 'none', date: 0 };
	return {
		site: s.site,
		...(s.kind ? { kind: s.kind } : {}),
		...(s.polled ? { polled: true } : {}),
		...(s.ingestsItself ? { ingestsItself: true } : {}),
		from: none,
		to: none,
		prints: 0,
		added: 0,
		edited: 0,
		favourites: 0,
		deleted: [],
		modern: 0,
		blocked: null,
		error
	};
};

/**
 * Each plan after the fetch: a fetched source is level at the cursor it reached (a polled site with the reads
 * it left, uploads with what still waits); one held back, not fetched or that couldn't be checked stays as planned.
 */
export const plansAfterFetch = (
	plans: readonly SourcePlan[],
	sources: readonly SourceRun[],
	lastApply: (site: string) => string | undefined
): SourcePlan[] =>
	plans.map((p) => {
		if (p.error) return p;
		const entry = sources.find((s) => s.site === p.site);
		const to = entry?.to;
		// A polled site is level at its new cursor, with the reads it left for the next update.
		if (to && entry?.counts && p.polled) {
			const left = entry.counts.left ?? 0;
			return {
				...p,
				from: to,
				to,
				added: 0,
				edited: 0,
				deleted: [],
				behind: 0,
				position: lastApply(p.site) ?? p.position,
				stateText: left ? `${n(left)} left` : undefined
			};
		}
		// A source that admits its own records (uploads) is level at its new cursor, with what it left waiting.
		if (to && entry?.counts) {
			const left = entry.counts.left ?? 0;
			return { ...p, from: to, to, added: left, position: left ? `${n(left)} still waiting` : 'none waiting', stateText: undefined };
		}
		return to && to.id === p.to.id ? { ...p, from: to, added: 0, edited: 0, favourites: 0, deleted: [], modern: 0 } : p;
	});
