/**
 * Figures the Overview shows for the removals step and the fetch step's record store, built from the
 * scripts' `--json` results. Pure, for tests.
 */
import { detail, type DetailGroup } from '#lib/sync.js';
import type { RecordsResult } from '../records';
import type { RemovalsResult } from '../removals';

const n = (x: number) => x.toLocaleString('en-US');

/** What this run of `removals` did, then the stage's removed prints so far (its tombstones), labelled as totals. */
export function removalsDetails(r: RemovalsResult): DetailGroup[] {
	const work = [
		...detail('deleted prints swept for the first time', r.newlySwept),
		...detail('blocks added', r.blocksAdded),
		...detail('blocks dropped', r.blocksDropped),
		...detail('render rows removed', r.localRows),
		...detail('folders removed on disk', r.diskPaths),
		...detail('late render files deleted', r.lateRenderFiles),
		...detail('screenshots removed', r.screenshots)
	];
	const gone = r.deleted - r.takedowns;
	const groups: DetailGroup[] = [
		{ title: 'This update', rows: work.length ? work : [{ label: 'removed', value: r.ok ? 'nothing new to remove' : 'nothing' }] }
	];
	// A run that failed before reading the stage's tombstones knows no total.
	if (r.ok || r.deleted)
		groups.push({
			title: 'On the site so far',
			rows: [
				{
					label: 'removed prints',
					value: r.deleted
						? `${n(r.deleted)} (${[
								r.takedowns ? `${n(r.takedowns)} taken down on request` : '',
								gone ? `${n(gone)} deleted by their owner or source` : ''
							]
								.filter(Boolean)
								.join(', ')})`
						: 0
				}
			]
		});
	return groups;
}

/** The removals step's summary: the script's ✓ line, or plainly "nothing new to remove" when it had nothing to do. */
export const removalsSummary = (r: RemovalsResult) =>
	r.nothingToDo ? `nothing new to remove (${n(r.deleted)} removed prints so far, all swept here)` : r.summary.replace(/^[✓✗]\s*/, '');

/**
 * The fetch step's record-store figures. `records` runs before the polled sites (codex, fprints) admit what
 * the fetch brought, so their new prints reach the store in the ingest step, which reports them ("record
 * store: codex"). Here a polled site is named only when this run did something to it (a print removed,
 * a changed record, a failure), so the fetch step never shows "codex: 0 new" next to the ingest step's
 * "12 new". The sums cover every site: they are what this run did.
 */
export function recordStoreFetch(store: RecordsResult, polled: readonly string[]): { line: string; group: DetailGroup } {
	const sites = Object.entries(store.sites);
	const sum = (k: 'added' | 'changed' | 'removed' | 'vanished' | 'failed') => sites.reduce((t, [, c]) => t + c[k], 0);
	const quiet = sites
		.filter(([site, c]) => polled.includes(site) && c.added + c.changed + c.removed + c.vanished + c.failed === 0)
		.map(([site]) => site);
	const parts = sites
		.filter(([site]) => !quiet.includes(site))
		.map(
			([site, c]) =>
				`${site}: ${n(c.listed)} on the site, ${n(c.added)} new, ${n(c.changed)} changed, ${n(c.removed + c.vanished)} removed` +
				(c.failed ? `, ${n(c.failed)} failed` : '') +
				(c.left ? `, ${n(c.left)} left` : '')
		);
	return {
		line:
			[...parts, ...(quiet.length ? [`${quiet.join(', ')}: in the ingest step`] : [])].join(' · ') +
			`; ${n(store.total)} records in the store`,
		group: {
			title: 'record store',
			rows: [
				...detail('records', store.total, { always: true }),
				...detail('new', sum('added')),
				...detail('changed', sum('changed')),
				...detail('removed', sum('removed') + sum('vanished')),
				...detail('failed, tried again next update', sum('failed'), { tone: 'bad' }),
				...(quiet.length ? [{ label: quiet.join(', '), value: 'new prints counted in the ingest step', muted: true }] : [])
			]
		}
	};
}
