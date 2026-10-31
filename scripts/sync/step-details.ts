/**
 * Figures the Overview shows for the removals step, the fetch step's record store, the authors step and the render step, built
 * from the scripts' `--json` results and the render run's row. Pure, for tests.
 */
import type { RenderStages } from '#lib/render-stages.js';
import { detail, GROUP, ROW, type DetailGroup } from '#lib/sync.js';
import type { AuthorsResult } from '../authors';
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

/** The authors step's figures (`authors --json`): authors named (the board's Authors cell), lookups and writes. */
export const authorsDetails = (a: AuthorsResult): DetailGroup[] => [
	{
		title: GROUP.authors,
		rows: [
			...detail(ROW.authorsNamed, a.named, { always: true }),
			...detail('asked Firebase', a.asked),
			...detail('prints given a name', a.prints),
			...detail('documents rewritten', a.documents),
			...detail('D1 rows written', a.rows),
			...detail('authors still to ask', a.left, { tone: 'warn' })
		]
	}
];

/** The render run's row, as the render step reads it. */
export interface RenderRowCounts {
	prints_total: number;
	prints_rendered: number;
	rendered: number;
	failed: number;
	uploaded: number;
	uploads_pending: number;
}

/** A site's name for people: the upload site is "uploads", as on the board. */
const siteName = (site: string) => (site === 'upload' ? 'uploads' : site);

/**
 * The render step's figures: the run as a whole, then each source's stages, its clean up and search flags
 * (from `options.stages`, which every run writes from its first heartbeat; without them, only the first group).
 */
export function renderStageDetails(row: RenderRowCounts, stages: RenderStages | null): DetailGroup[] {
	const any = row.prints_total > 0;
	const groups: DetailGroup[] = [
		{
			title: 'This run',
			rows: [
				{ label: 'prints with work', value: row.prints_total },
				...detail('pages drawn', row.rendered, { always: any }),
				...detail('prints drawn', row.prints_rendered),
				...detail('pages uploaded', row.uploaded, { always: any }),
				...detail('failed', row.failed, { always: any, tone: 'bad' }),
				...detail('uploads left for the next update', row.uploads_pending, { tone: 'warn' })
			]
		}
	];
	if (!stages) return groups;
	for (const [site, s] of Object.entries(stages.sites)) {
		if (!s) continue;
		groups.push({
			title: `Render: ${siteName(site)}`,
			rows: [
				...detail('prints', s.plan.prints, { always: true }),
				...detail('pages to draw', s.plan.queued),
				...detail('unchanged', s.plan.unchanged),
				...detail('skipped', s.plan.skipped),
				...detail('pages drawn', s.draw.drawn),
				...(s.plan.prints ? [{ label: 'prints drawn', value: `${n(s.draw.printsDone)} of ${n(s.plan.prints)}` }] : []),
				...detail('failed', s.plan.failed + s.draw.failed, { tone: 'bad' }),
				...detail('pages uploaded', s.upload?.pages),
				...(s.plan.prints && s.upload?.printsUp !== undefined
					? [{ label: 'prints uploaded', value: `${n(s.upload.printsUp)} of ${n(s.plan.prints)}` }]
					: []),
				...detail('waiting to upload', s.upload?.waiting, { tone: 'warn' }),
				...(s.thumbs?.of ? [{ label: 'thumbnails', value: `${n(s.thumbs.done)} of ${n(s.thumbs.of)} prints` }] : [])
			]
		});
	}
	const c = stages.cleanup;
	if (c)
		groups.push({
			title: 'Clean up',
			rows: [
				...detail('replaced files deleted', c.deleted + c.thumbsDeleted, { always: c.state === 'done' }),
				...detail('kept (used again)', c.kept),
				...detail('failed', c.failed, { tone: 'bad' }),
				...detail('still in their grace period', c.pending),
				...(c.state === 'skipped' ? [{ label: 'at the end', value: 'not run (stopped)', muted: true }] : [])
			]
		});
	const f = stages.flags;
	if (f)
		groups.push({
			title: `Search flags on ${f.stage}`,
			rows:
				f.state === 'failed'
					? [{ label: 'failed', value: f.error ?? 'unknown error', tone: 'bad' }]
					: f.state === 'done'
						? [
								...detail('rows written', f.rowsWritten ?? 0, { always: true }),
								...(f.bumped ? [{ label: 'page cache', value: 'bumped' }] : [])
							]
						: [{ label: 'state', value: f.state }]
		});
	return groups;
}
