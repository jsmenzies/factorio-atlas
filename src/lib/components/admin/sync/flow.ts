/**
 * The Update tab's board: one row per source (factorioprints, codex, fprints, uploads; any other site the render
 * run drew) across the update's steps in order: Changes (at the source), Added (one gate, one source at a time),
 * Authors, Screenshots, then the render run's stages Plan | Draw | Upload | Thumbnails; and a Shared row for what
 * is done once (screenshots' sizing and upload; the run's summary, Clean up and Search flags).
 *
 * Every cell has one pattern: a status (`CellKind`) and, only when something happened, one fact per line (zeros
 * left out; a bare ✓ means nothing happened), at most CELL_LINES lines with its label, so every cell keeps one size
 * (fitCell: the rest go in its tooltip). At most one cell is running outside the Render group, whose stages
 * overlap (a print moves on as soon as it's drawn), so its cells are part-way instead.
 *
 * Built only from what the page has: the sources' plan (sync_meta 'plan'), the update running now or the last one
 * (its `sources`, its steps' DetailGroups and the render step's `render` stages), the latest render run's row
 * (its `options.stages` while the step runs) and the log's live counts (#lib/sync-progress.js). Pure and
 * browser-safe.
 */
import type { RenderRun } from '#lib/server/admin/render.js';
import { stageTotals, type RenderStages, type SiteStages } from '#lib/render-stages.js';
import type { LogProgress } from '#lib/sync-progress.js';
import { recordsSeen } from '#lib/sync-progress.js';
import { SOURCE_SITES } from '#lib/sources.js';
import type { Site } from '#lib/print-id.js';
import {
	GROUP,
	groupOf,
	POLLED_SITES,
	ROW,
	sourceMoved,
	stepLabel,
	SYNC_STEPS,
	valueOf,
	type DetailGroup,
	type PolledSiteId,
	type SourcePlan,
	type SyncPlan,
	type SyncRun,
	type SyncSettings,
	type SyncStep,
	type SyncStepId
} from '#lib/sync.js';
import { duration, int } from '../metrics.js';
import { shortCommit, type UpdateState } from './view.js';

/**
 * ✓ done; running (a spinner); found, waiting to run (an amber dot); part: this source part-way through a stage
 * (a part-filled circle); warn: done, with something to look at (!); bad: couldn't run (✕); wait: not run yet (a
 * grey ring); na: doesn't apply (—).
 */
export type CellKind = 'done' | 'run' | 'found' | 'part' | 'warn' | 'bad' | 'wait' | 'na';

/** One line in a cell: its number in bold, then a few words ("4 new"). */
export interface Fact {
	n?: number | string;
	text: string;
	tone?: 'warn' | 'bad';
}

export interface Cell {
	kind: CellKind;
	facts: Fact[];
	/** The one-sentence tooltip: what the cell's figures are, or why it is empty. */
	tip: string;
	/** A running cell's progress, 0–100. */
	bar?: number | null;
	/** Shared cells name their part ("Clean up"). */
	label?: string;
}

export const COLUMNS = ['changes', 'added', 'authors', 'shots', 'plan', 'draw', 'upload', 'thumbs'] as const;
export type ColumnId = (typeof COLUMNS)[number];

export interface Row {
	/** The source's name on the board: factorioprints, codex, fprints, uploads (or a site only the render drew). */
	site: string;
	/** What it is, in one sentence (the name's tooltip). */
	tip: string;
	/** A polled site's switch (shown before an update). */
	toggle: PolledSiteId | null;
	plan: SourcePlan | null;
	/** Held back by the last check: Accept fetches it anyway. */
	held: { reason: string; site: string; id: string; polled: boolean } | null;
	cells: Record<ColumnId, Cell>;
	/** The last column (index into COLUMNS) this row's prints have got to, for its line; -1 for none. */
	reach: number;
	/** Prints the gate made new on the site. */
	newPrints: number;
}

export interface Shared {
	sizing: Cell;
	/** Under Plan and Draw: the run's settings, then (once it runs) its time and prints. */
	summary: { title: string; lines: string[] };
	cleanup: Cell;
	flags: Cell;
}

export type BoardMode = 'before' | 'live' | 'last';

export interface Flow {
	/** before: what the last check found, nothing to the right has run; live: this update; last: the last update's results. */
	mode: BoardMode;
	live: boolean;
	/** The step running now (live), else null. */
	current: SyncStepId | null;
	/** The words above the board's right edge. */
	caption: { lead: string; rest: string };
	rows: Row[];
	shared: Shared;
	/** Render workers the update asks for (null: the runner's default). */
	threads: number | null;
	/** While the render step runs: its run's phase and progress, for the sentence and the top box's bar. */
	renderNow: RenderNow | null;
	/** Prints the gate made new on the site in this (or the last) update, as far as recorded. */
	newPrints: number;
}

const RENDER_TIP = 'One render run for every source, under one limit: a source can get none because the batch was full.';
const PRINT_WORDS = 'A print is one post (a blueprint or a book); a page is one blueprint drawn.';
const MATCH_TIP = 'matched = the same blueprint already on the site: added to it as “Also on …”.';
const AUTHORS_NA: Record<string, string> = {
	codex: 'Not this source: names come with the record (the post’s username, unless anonymous).',
	fprints: 'Not this source: fprints gives no author names yet, so its prints show as unknown author.',
	uploads: 'Not this source: an upload shows its uploader’s account name.'
};

const ROWS: { site: string; plan: (p: SourcePlan) => boolean }[] = [
	{ site: 'factorioprints', plan: (p) => !p.polled && !p.ingestsItself },
	...POLLED_SITES.map(({ site }) => ({ site, plan: (p: SourcePlan) => p.site === site })),
	{ site: 'uploads', plan: (p) => !!p.ingestsItself }
];
/** A board row's key in the render stages (the uploads row is the `upload` site). */
const stageKey = (site: string) => (site === 'uploads' ? 'upload' : site) as keyof RenderStages['sites'];

// --- cells

const fact = (n: number | string | null | undefined, text: string, tone?: Fact['tone']): Fact[] =>
	n === null || n === undefined || n === 0 || n === '0' ? [] : [{ n, text, ...(tone ? { tone } : {}) }];
const cell = (kind: CellKind, facts: Fact[] = [], tip = '', extra: Partial<Cell> = {}): Cell => ({ kind, facts, tip, ...extra });
/** Done, or done with something to look at when a fact carries a tone. */
const settled = (facts: Fact[], tip: string): Cell => cell(facts.some((f) => f.tone) ? 'warn' : 'done', facts, tip);
const pct = (value: number, of: number) => (of > 0 ? Math.min(100, Math.round((value / of) * 100)) : 0);

/** Text lines a cell shows under its status icon, its label included: the board keeps room for exactly this many. */
export const CELL_LINES = 3;
const factText = (f: Fact) => (f.n === undefined ? f.text : `${typeof f.n === 'number' ? int(f.n) : f.n}${f.text ? ` ${f.text}` : ''}`);

/**
 * A cell cut to `lines` text lines (its label takes one). Failures and warnings are kept first, then the rest in
 * order, shown in their own order; the facts left out go at the end of the tooltip.
 */
export function fitCell(c: Cell, lines = CELL_LINES): Cell {
	const room = Math.max(0, lines - (c.label ? 1 : 0));
	if (c.facts.length <= room) return c;
	const rank = (f: Fact) => (f.tone === 'bad' ? 0 : f.tone === 'warn' ? 1 : 2);
	const keep = new Set(
		c.facts
			.map((f, i) => ({ i, r: rank(f) }))
			.sort((a, b) => a.r - b.r || a.i - b.i)
			.slice(0, room)
			.map((x) => x.i)
	);
	const rest = c.facts.filter((_, i) => !keep.has(i)).map(factText);
	return { ...c, facts: c.facts.filter((_, i) => keep.has(i)), tip: `${c.tip}${c.tip ? ' ' : ''}Also: ${rest.join(', ')}.` };
}

const stepOf = (run: SyncRun | null, id: SyncStepId) => run?.steps.find((s) => s.id === id);
const stepNo = (id: SyncStepId) => SYNC_STEPS.findIndex((s) => s.id === id) + 1;
/** A group's rows as facts (zeros and muted rows left out). */
const factsOf = (g: DetailGroup | undefined, skip: string[] = [], rename: Record<string, string> = {}): Fact[] =>
	(g?.rows ?? []).filter((r) => !r.muted && !skip.includes(r.label)).flatMap((r) => fact(r.value, rename[r.label] ?? r.label, r.tone));
/** A group's rows as "label 12 · label 3", for a tooltip. */
const rowsText = (g: DetailGroup | undefined, only?: string[]) =>
	(g?.rows ?? [])
		.filter((r) => !r.muted && (!only || only.includes(r.label)))
		.map((r) => `${r.label} ${typeof r.value === 'number' ? int(r.value) : r.value}`)
		.join(' · ');

const notYet = (id: SyncStepId) => cell('wait', [], `Not run yet: step ${stepNo(id)}, ${stepLabel(id)}.`);
/** A step that ended without running for this cell: skipped (its reason), stopped, or failed. */
const notRun = (step: SyncStep): Cell =>
	step.status === 'failed'
		? cell('bad', [], `${stepLabel(step.id)} failed: ${step.summary ?? `exit ${step.code ?? '?'}`}`)
		: cell('wait', [], step.status === 'stopped' ? 'Not run: the update stopped.' : `Not run: ${step.summary ?? 'skipped'}.`);
/** The step hasn't reached this cell: before an update, or still pending. */
const waiting = (mode: BoardMode, step: SyncStep | undefined): step is undefined => mode === 'before' || !step || step.status === 'pending';

/** What a polled site would read now: every new, changed and gone print. */
const toRead = (p: SourcePlan) => p.added + p.edited + p.deleted.length;

function changesBefore(p: SourcePlan | null, site: string, ago: string): Cell {
	if (!p) return cell('wait', [], 'Not checked yet: Check again reads every source.');
	if (p.off) return cell('na', [], 'Turned off in the settings: not fetched.');
	if (p.error) return cell('bad', [{ text: 'couldn’t check' }], `The last check couldn’t reach it: ${p.error}`);
	if (p.blocked) return cell('warn', [{ text: 'held back' }], `Held back, not fetched until accepted: ${p.blocked}`);
	if (!sourceMoved(p))
		return cell(
			'done',
			[],
			p.polled
				? `${int(p.prints)} prints on the site; nothing new since the last update (checked ${ago}).`
				: site === 'uploads'
					? 'No uploads waiting: they are admitted on the site as they’re posted.'
					: `GitHub mirror at ${shortCommit(p.to.id)}: nothing new since the last update (checked ${ago}).`
		);
	if (p.ingestsItself) return cell('found', fact(p.added, 'waiting'), p.position ?? 'Uploads waiting to be admitted.');
	if (p.polled)
		return cell(
			'found',
			[...fact(p.added, 'new'), ...fact(p.edited, 'changed'), ...fact(p.deleted.length, 'gone?')],
			`Found by the last check, ${ago}: ${int(p.prints)} prints on the site; ${int(toRead(p))} to read, one a second` +
				(p.left ? ` (${int(p.left)} left from the last update)` : '') +
				'.'
		);
	return cell(
		'found',
		[...fact(p.added, 'new'), ...fact(p.edited, 'edited'), ...fact(p.deleted.length, 'deleted', 'warn')],
		`Found by the last check, ${ago}: ${p.behind ? `${int(p.behind)} commits behind` : 'behind'}` +
			(p.favourites ? `, ${int(p.favourites)} only favourite counts changed` : '') +
			'.'
	);
}

/** What the update's fetch did for a site (or is doing: the log's count while it reads). */
function changesCell(
	mode: BoardMode,
	run: SyncRun | null,
	site: string,
	plan: SourcePlan | null,
	progress: LogProgress | null,
	ago: string
): Cell {
	if (mode === 'before') return changesBefore(plan, site, ago);
	const fetch = stepOf(run, 'fetch');
	if (!run || waiting(mode, fetch)) return notYet('fetch');
	const entry = run.sources.find((s) => s.site === site);
	if (entry?.blocked) return cell('warn', [{ text: 'held back' }], `Held back, not fetched: ${entry.blocked}`);
	const running = fetch.status === 'running';
	if (entry?.polled) {
		const c = entry.counts;
		if (!c) {
			if (!running)
				return plan?.off ? cell('na', [], 'Turned off in the settings: not fetched.') : cell('done', [], 'Nothing new to read.');
			const of = plan && !plan.off && sourceMoved(plan) ? toRead(plan) : 0;
			if (!of) return cell('done', [], 'Nothing new to read.');
			const seen = progress?.step === 'fetch' ? recordsSeen(progress, site) : 0;
			// Reading now, or waiting for the sites before it (one request a second each).
			return seen
				? cell('run', [{ n: `${int(seen)} of ${int(of)}`, text: 'read' }], 'Reading its new and changed prints, about one a second.', {
						bar: pct(seen, of)
					})
				: cell('wait', [], `Waiting its turn: the sources are read one after another (${int(of)} to read).`);
		}
		const onSite = valueOf(
			groupOf(fetch, (t) => t === site),
			ROW.printsOnSite
		);
		return settled(
			[
				...fact(c['records read'], 'read'),
				...fact(c.changed, 'changed'),
				...fact(c['gone from the site'], 'gone', 'warn'),
				...fact(c.failed, 'failed', 'bad'),
				...fact(c.left, 'left over', 'warn')
			],
			`${onSite !== undefined ? `${int(onSite)} prints on the site; ` : ''}read in this update: ${int(c.new ?? 0)} new, ${int(c.changed ?? 0)} changed.`
		);
	}
	const g = groupOf(fetch, (t) => t === site);
	if (running && !g) {
		// Its entry is written before its fetch; the plan (saved before the update) says whether it has anything.
		if (!entry) return cell('wait', [], 'Waiting its turn: the sources are read one after another.');
		const working =
			plan && !plan.off && !plan.error && sourceMoved(plan) && (entry.ingestsItself ? !entry.counts : entry.from?.id === entry.to?.id);
		if (working)
			return cell('run', [], entry.ingestsItself ? 'Admitting the waiting uploads through the gate.' : 'Fetching the mirror (git fetch).');
		return cell('done', [], entry.ingestsItself ? 'No uploads waiting.' : `Already at its latest (${shortCommit(entry.to?.id)}).`);
	}
	if (!entry) {
		if (plan?.error) return cell('bad', [], `Couldn’t check: ${plan.error}`);
		return fetch.status === 'done' || fetch.status === 'warning' ? cell('done', [], 'Nothing to fetch.') : notRun(fetch);
	}
	if (entry.ingestsItself)
		return settled(
			factsOf(g, [ROW.waiting, ROW.oldestWaiting], { [ROW.failedRetried]: 'failed', [ROW.stillProcessing]: 'processing' }),
			'Uploads are admitted on the site as they’re posted; the fetch admits any left waiting.'
		);
	// The mirror: a git fetch, then the backfill reads the clone.
	if (entry.to && entry.from?.id === entry.to.id)
		return cell('done', [], `GitHub mirror already at its latest (${shortCommit(entry.to.id)}): nothing new.`);
	return settled(factsOf(g, [ROW.position]), `GitHub mirror ${shortCommit(entry.from?.id)} → ${shortCommit(entry.to?.id)}.`);
}

/** How a site's records went through the one gate: the backfill (factorioprints), or the polled admission's outcome. */
function addedCell(mode: BoardMode, run: SyncRun | null, site: string, progress: LogProgress | null): Cell {
	const ingest = stepOf(run, 'ingest');
	if (!run || waiting(mode, ingest)) return notYet('ingest');
	if (site === 'uploads')
		return cell('done', [], 'Admitted on the site as they’re posted (the fetch admits any left waiting): nothing for this step.');
	if (site === 'factorioprints') {
		const g = groupOf(ingest, (t) => !t.includes(':') && t.split(', ').includes(site));
		if (g)
			return settled(
				[
					...fact(valueOf(g, ROW.analysed), 'analysed'),
					...fact(valueOf(g, ROW.reindexed), 're-indexed'),
					...fact(valueOf(g, ROW.folded), 'folded'),
					...fact(valueOf(g, ROW.failed), 'failed', 'bad')
				],
				`The backfill over the mirror clone: ${rowsText(g) || 'nothing to do'}.`
			);
		const why = /^backfill skipped: ([^·]+)/.exec(ingest.summary ?? '')?.[1]?.trim();
		if (why) return cell('done', [], `Backfill skipped: ${why}.`);
		if (ingest.status === 'running')
			return Object.keys(progress?.step === 'ingest' ? progress.toAdmit : {}).length
				? cell('done', [], 'The backfill ran; its figures come at the step’s end.')
				: cell('run', [{ text: 'analysing' }], 'The backfill reads the mirror clone and puts new and edited prints through the gate.');
		return notRun(ingest);
	}
	const g = groupOf(ingest, (t) => t === GROUP.gate(site));
	if (g) {
		const of = valueOf(g, ROW.toAdmit) ?? 0;
		if (!of) return cell('done', [], 'Nothing to add.');
		const updated = (valueOf(g, ROW.updated) ?? 0) + (valueOf(g, ROW.unchanged) ?? 0);
		const suggest = valueOf(g, ROW.suggestions);
		return settled(
			[
				...fact(valueOf(g, ROW.newPrints), 'new'),
				...fact(valueOf(g, ROW.joined), 'matched'),
				...fact(updated, 'updated'),
				...fact(valueOf(g, ROW.blocked), 'blocked', 'warn'),
				...fact(valueOf(g, ROW.unreadable), 'unreadable', 'warn'),
				...fact(valueOf(g, ROW.failedRetried), 'failed', 'bad')
			],
			`${int(of)} records through the gate${suggest ? `, ${int(suggest)} new with suggestions` : ''}. ${MATCH_TIP}`
		);
	}
	if (ingest.status === 'running') {
		const of = progress?.step === 'ingest' ? progress.toAdmit[site] : undefined;
		if (!progress || of === undefined) {
			const entry = run.sources.find((s) => s.site === site);
			return entry?.counts?.['records read']
				? cell('wait', [], 'Waiting its turn: one source at a time, factorioprints (the backfill) first.')
				: cell('done', [], 'Nothing to add.');
		}
		const s = progress.sites[site] ?? {};
		const seen = recordsSeen(progress, site);
		// Sites are admitted one after another: only the last one the log started is still going.
		if (Object.keys(progress.toAdmit).at(-1) === site)
			return cell(
				'run',
				[{ n: `${int(seen)} of ${int(of)}`, text: 'added' }],
				'Through the gate now: checked, matched, analysed, indexed and saved one at a time.',
				{ bar: pct(seen, of) }
			);
		return settled(
			[
				...fact(s.new, 'new'),
				...fact(s.joined, 'matched'),
				...fact((s.updated ?? 0) + (s.unchanged ?? 0), 'updated'),
				...fact(s.undecodable, 'unreadable', 'warn'),
				...fact(s.failed, 'failed', 'bad')
			],
			`${int(seen)} of ${int(of)} records through the gate; the full figures come at the step’s end. ${MATCH_TIP}`
		);
	}
	return ingest.status === 'done' || ingest.status === 'warning' ? cell('done', [], 'Nothing to add.') : notRun(ingest);
}

function authorsCell(mode: BoardMode, run: SyncRun | null, site: string): Cell {
	if (site !== 'factorioprints') return cell('na', [], AUTHORS_NA[site] ?? 'Not this source: names come with its records.');
	const a = stepOf(run, 'authors');
	if (waiting(mode, a)) return notYet('authors');
	const tip = 'Names from their records first, then Firebase for every new author id, each answer kept.';
	if (a.status === 'running') return cell('run', [], tip);
	if (a.status === 'skipped' || a.status === 'stopped') return notRun(a);
	const g = groupOf(a, (t) => t === GROUP.authors);
	return cell(
		a.status === 'failed' ? 'bad' : a.status === 'warning' ? 'warn' : 'done',
		fact(valueOf(g, ROW.authorsNamed), 'named'),
		`${tip}${g ? ` ${rowsText(g)}.` : a.summary ? ` ${a.summary}` : ''}`
	);
}

/** Which part of the screenshots step runs now, from its last command: Imgur, uploads, other sites, then sizing and upload. */
const SHOT_PARTS = ['imgur', 'uploads', 'sites', 'sizing'] as const;
type ShotPart = (typeof SHOT_PARTS)[number];
const shotPart = (command: string | null): ShotPart =>
	!command
		? 'imgur'
		: command.includes('--from-uploads')
			? 'uploads'
			: command.includes('--from-sites')
				? 'sites'
				: command.includes('--upload') || command.includes('screenshots-flags')
					? 'sizing'
					: 'imgur';
const partOf = (site: string): ShotPart | null =>
	site === 'factorioprints' ? 'imgur' : site === 'uploads' ? 'uploads' : POLLED_SITES.some((p) => p.site === site) ? 'sites' : null;

function shotsCell(mode: BoardMode, run: SyncRun | null, site: string, progress: LogProgress | null): Cell {
	const step = stepOf(run, 'screenshots');
	if (waiting(mode, step)) return notYet('screenshots');
	const part = partOf(site);
	if (!part) return cell('na', [], 'This source’s prints bring no screenshot to copy.');
	if (step.status === 'running') {
		const at = SHOT_PARTS.indexOf(shotPart(progress?.step === 'screenshots' ? progress.command : null));
		const mine = SHOT_PARTS.indexOf(part);
		if (part === 'sites' && at >= mine) {
			const c = progress?.shots.bySite[site];
			const facts = [...fact(c?.fetched, 'copied'), ...fact(c?.failed, 'failed', 'bad')];
			if (at > mine) return settled(facts, 'Copied from the site; the full figures come at the step’s end.');
			if (progress?.shots.last === site) return cell('run', facts, 'Copying this site’s images now, one a second.');
			return c
				? cell('part', facts, 'Part-way: its images are copied in turn with the other sites’.')
				: cell('wait', [], 'Waiting its turn.');
		}
		if (at > mine) return cell('done', [], 'Copied; the figures come at the step’s end.');
		if (at === mine)
			return cell('run', [], part === 'imgur' ? 'Copying new screenshots from Imgur.' : 'Copying approved upload screenshots.');
		return cell('wait', [], 'Waiting its turn: Imgur, then uploads, then other sites’ images.');
	}
	if (part === 'imgur') {
		const g = groupOf(step, (t) => t === GROUP.onThisMachine);
		if (g)
			return settled(
				[
					...fact(valueOf(g, ROW.fetched), 'copied'),
					...fact(valueOf(g, ROW.newlyDead), 'dead on Imgur', 'warn'),
					...fact(valueOf(g, ROW.failed), 'failed', 'bad')
				],
				`Imgur: ${rowsText(g, [ROW.alreadyCopied, ROW.deadOnImgur, ROW.toFetch])}.`
			);
	} else if (part === 'uploads') {
		const g = groupOf(step, (t) => t === GROUP.fromUploads);
		if (g)
			return settled(
				[...fact(valueOf(g, ROW.copiedFromRaw), 'copied'), ...fact(valueOf(g, ROW.failed), 'failed', 'bad')],
				`Approved upload screenshots: ${rowsText(g, [ROW.approved, ROW.alreadyUp, ROW.sized])}.`
			);
	} else {
		const g = groupOf(step, (t) => t === GROUP.siteShots(site));
		if (g)
			return settled(
				[
					...fact(valueOf(g, ROW.copiedNow), 'copied'),
					...fact(valueOf(g, ROW.goneAtSource), 'gone', 'warn'),
					...fact(valueOf(g, ROW.failedRetried), 'failed', 'bad')
				],
				`${site}’s own images for its prints: ${rowsText(g, [ROW.imagesShown, ROW.alreadyCopied, ROW.maybeDead])}.`
			);
	}
	if (step.status === 'skipped' || step.status === 'stopped' || step.status === 'failed') return notRun(step);
	return cell('done', [], 'Nothing to copy.');
}

function sizingCell(mode: BoardMode, run: SyncRun | null, progress: LogProgress | null): Cell {
	const label = 'Sizing and upload';
	const step = stepOf(run, 'screenshots');
	const tip = 'Every new image sized once (c320/c640/c960, l, og) and put in the screenshots bucket, then the search cards’ rows.';
	if (waiting(mode, step)) return cell('wait', [], `Not run yet: step ${stepNo('screenshots')}. ${tip}`, { label });
	if (step.status === 'running')
		return shotPart(progress?.step === 'screenshots' ? progress.command : null) === 'sizing'
			? cell('run', [], tip, { label })
			: cell('wait', [], `After the copies. ${tip}`, { label });
	const bucket = groupOf(step, GROUP.isBucket);
	if (!bucket) return { ...notRun(step), label };
	const put = bucket.rows.find((r) => r.label === ROW.filesPut)?.value;
	const m = typeof put === 'string' ? /^([\d,]+) \((.+)\)$/.exec(put) : null;
	const cards = groupOf(step, (t) => t === GROUP.searchCards);
	return {
		...settled(
			[
				...(m
					? [
							{ n: m[1], text: 'files' },
							{ n: m[2], text: '' }
						]
					: fact(typeof put === 'number' ? put : null, 'files')),
				...fact(valueOf(bucket, ROW.failed), 'failed', 'bad')
			],
			`${tip} ${rowsText(bucket, [ROW.alreadyUp, ROW.sizesMade, ROW.deleted])}${cards ? ` · cards: ${rowsText(cards)}` : ''}.`
		),
		label
	};
}

// --- render

/**
 * The render run's stages for this update. Once the step ended: its own (`step.render`), else the row it names
 * (`step.runId`), never another run's (one started by hand later). While it runs: the live run, if it started
 * after the step did.
 */
function stagesFor(
	run: SyncRun | null,
	latest: RenderRun | null,
	live: RenderRun | null
): { stages: RenderStages | null; row: RenderRun | null } {
	const step = stepOf(run, 'render');
	if (!step || step.status === 'pending') return { stages: null, row: null };
	if (step.status !== 'running') {
		const row = [latest, live].find((r) => r && step.runId !== undefined && r.id === step.runId) ?? null;
		return { stages: step.render ?? row?.options.stages ?? null, row };
	}
	const row = live && step.startedAt !== undefined && live.started_at >= step.startedAt - 1000 ? live : null;
	return { stages: row?.options.stages ?? null, row };
}

function renderCells(
	mode: BoardMode,
	run: SyncRun | null,
	site: string,
	stages: RenderStages | null,
	row: RenderRun | null,
	retrying: boolean
): Cell[] {
	const step = stepOf(run, 'render');
	const four = (c: Cell) => [c, c, c, c];
	if (waiting(mode, step)) {
		const c = notYet('render');
		return retrying ? [{ ...c, tip: `${c.tip} It will retry failed pages (this update only).` }, c, c, c] : four(c);
	}
	const live = step.status === 'running';
	if (!stages)
		return four(
			live ? cell('wait', [], 'Picking the prints with work: the top list, then records changed since they were drawn.') : notRun(step)
		);
	const s: SiteStages | undefined = stages.sites[stageKey(site)];
	const queueing = live && row?.state === 'starting';
	if (!s)
		return four(queueing ? cell('wait', [], 'Queueing the prints with work.') : cell('done', [], `None in this batch. ${RENDER_TIP}`));
	const { plan, draw, upload, thumbs } = s;
	const planCell = cell(
		queueing ? 'part' : plan.failed ? 'warn' : 'done',
		[
			...fact(plan.prints, 'prints'),
			...fact(plan.queued, 'pages to draw'),
			...fact(plan.skipped, 'skipped'),
			...fact(plan.failed, 'failed before', 'warn')
		],
		`${PRINT_WORDS} ${int(plan.pages)} pages looked at, ${int(plan.unchanged)} unchanged (drawn before from the same input); skipped = ` +
			`pre-2.0, empty, modded or undecodable${plan.failed ? '; failed before = failed every attempt in an earlier run, or no record' : ''}.` +
			`${retrying ? ' Retrying failed pages: pages that failed every attempt before are drawn again.' : ''} ${RENDER_TIP}`
	);
	/** "x of y prints", when the run has prints from this source. */
	const ofPrints = (x: number | undefined): Fact[] =>
		x === undefined || !plan.prints ? [] : [{ n: `${int(x)} of ${int(plan.prints)}`, text: 'prints' }];
	const drawTip = 'Biggest pages first; a page that fails three times is left for the next update.';
	const drawCell = !plan.queued
		? queueing
			? cell('wait', [], 'Queueing.')
			: cell('done', [], 'Nothing to draw: every page unchanged or skipped.')
		: cell(
				live && draw.left ? 'part' : draw.failed || draw.left ? 'warn' : 'done',
				[
					...fact(draw.drawn, 'pages drawn'),
					...ofPrints(draw.printsDone),
					...fact(draw.failed, 'failed', 'bad'),
					...fact(draw.left, live ? 'to draw' : 'left', live ? undefined : 'warn')
				],
				`${draw.left && !live ? `${drawTip} The run stopped with pages left: the next update draws them.` : drawTip} ` +
					'x of y prints: prints with every page drawn (or failed for good).'
			);
	const uploadCell = !upload
		? cell('na', [], 'This run doesn’t upload.')
		: cell(
				live && (upload.waiting || (plan.queued && draw.left)) ? 'part' : upload.waiting || upload.failing ? 'warn' : 'done',
				[
					...fact(upload.pages, 'pages uploaded'),
					...ofPrints(upload.printsUp),
					...fact(upload.waiting, 'waiting', live ? undefined : 'warn'),
					...fact(upload.failing, 'failing', 'bad')
				],
				`Each page’s files go to the renders bucket as soon as it’s drawn (pages drawn earlier and not up yet go too): ` +
					`${int(upload.files)} files so far.${live && draw.left ? ` Up to ${int(draw.left)} more pages to come.` : ''}` +
					`${upload.printsUp !== undefined ? ' x of y prints: prints with every page drawn and up.' : ''}` +
					`${upload.waiting && !live ? ' Waiting pages go up in the next update.' : ''}`
			);
	const more = live && (draw.left > 0 || draw.printsDone < plan.prints);
	const thumbsCell = !thumbs
		? cell('na', [], 'Thumbnails are off for this run.')
		: thumbs.of
			? cell(
					live && (thumbs.done < thumbs.of || more) ? 'part' : 'done',
					[
						...(thumbs.pagesOf ? [{ n: `${int(thumbs.pagesMade ?? 0)} of ${int(thumbs.pagesOf)}`, text: 'pages' }] : []),
						{ n: `${int(thumbs.done)} of ${int(thumbs.of)}`, text: 'prints' },
						...fact(thumbs.waitingUpload, 'waiting on upload')
					],
					'Made (and uploaded) per print once its pages are final. x of y pages: thumbnail pages made of those to make (counted as ' +
						'each print is looked at; prints already up to date have none); x of y prints: prints done; waiting on upload: prints ' +
						'whose thumbnails are made, waiting for their render files to go up first.'
				)
			: more
				? cell('wait', [], 'Made per print once its pages are final.')
				: cell('done', [], 'No thumbnails to make.');
	return [planCell, drawCell, uploadCell, thumbsCell];
}

function sharedRender(
	mode: BoardMode,
	run: SyncRun | null,
	settings: SyncSettings | null,
	stages: RenderStages | null,
	row: RenderRun | null,
	now: number
): Pick<Shared, 'summary' | 'cleanup' | 'flags'> {
	const step = stepOf(run, 'render');
	const lines = settings
		? settings.render
			? [
					[
						settings.workers ? `${int(settings.workers)} threads` : 'default threads',
						settings.perUpdate === null ? 'every print with work' : `≤ ${int(settings.perUpdate)} prints`,
						settings.top ? `top ${int(settings.top)}` : ''
					]
						.filter(Boolean)
						.join(' · ')
				]
			: ['render is off in the settings']
		: [];
	const started = mode !== 'before' && step && step.status !== 'pending' ? step.startedAt : undefined;
	const took = started !== undefined ? (step!.finishedAt ?? now) - started : 0;
	const t = stages ? stageTotals(stages) : null;
	if (t) lines.push(`${int(t.prints)} prints · ${int(t.drawn)} pages drawn${t.failed ? ` · ${int(t.failed)} failed` : ''}`);
	const summary = {
		title:
			started !== undefined && (stages || row)
				? `One run · ${duration(took)}${step!.status === 'running' ? ' so far' : ''}`
				: 'This run’s settings',
		lines
	};
	const cleanupLabel = 'Clean up';
	const flagsLabel = 'Search flags';
	const cleanupTip = 'Replaced files whose 15 min grace is over, deleted after the last upload.';
	const flagsTip = 'render:flags on the stage (“has a render” and covers), then a page-cache bump.';
	if (waiting(mode, step))
		return {
			summary,
			cleanup: cell('wait', [], `Not run yet: step ${stepNo('render')}. ${cleanupTip}`, { label: cleanupLabel }),
			flags: cell('wait', [], `Not run yet: step ${stepNo('render')}, last. ${flagsTip}`, { label: flagsLabel })
		};
	if (!stages) {
		const c = step.status === 'running' ? cell('wait', [], 'Not run yet.') : notRun(step);
		return { summary, cleanup: { ...c, label: cleanupLabel }, flags: { ...c, label: flagsLabel } };
	}
	const c = stages.cleanup;
	const cleanup: Cell = !c
		? cell('na', [], 'This run doesn’t upload.')
		: c.state === 'waiting'
			? cell('wait', [], cleanupTip)
			: c.state === 'running'
				? cell('run', [], cleanupTip)
				: c.state === 'skipped'
					? cell('wait', [], 'Not run: the run stopped; what’s due is deleted next run.')
					: settled(
							[...fact(c.deleted + c.thumbsDeleted, 'deleted'), ...fact(c.pending, 'in grace'), ...fact(c.failed, 'failed', 'bad')],
							`Replaced files deleted after their 15 min grace (${int(c.thumbsDeleted)} of them thumbnails); ${int(c.kept)} kept, used ` +
								`again; ${int(c.pending)} wait out their grace for a later run.`
						);
	const f = stages.flags;
	const flags: Cell = !f
		? cell('na', [], 'This run doesn’t set search flags (no --flags).')
		: f.state === 'waiting'
			? cell('wait', [], `Last, on ${f.stage}. ${flagsTip}`)
			: f.state === 'running'
				? cell('run', [], `On ${f.stage} now. ${flagsTip}`)
				: f.state === 'failed'
					? cell('bad', [{ text: 'failed' }], `${f.error ?? 'Failed'}: run bun run render:flags --stage ${f.stage} by hand.`)
					: cell(
							'done',
							[...fact(f.rowsWritten, 'rows written'), ...(f.bumped ? [{ text: 'cache bumped' }] : [])],
							f.rowsWritten || f.bumped
								? `render:flags on ${f.stage}: flags and covers set${f.bumped ? ', page cache bumped' : ''}.`
								: `Already in step on ${f.stage}: nothing written.`
						);
	return { summary, cleanup: { ...cleanup, label: cleanupLabel }, flags: { ...flags, label: flagsLabel } };
}

/** What the render step is doing now, and how far it is: the sentence at the top and its bar. */
export interface RenderNow {
	phase: 'picking' | 'queueing' | 'drawing' | 'thumbnails' | 'uploads' | 'deletions' | 'flags';
	sentence: string;
	/** Its count, when it has one (37 of 50 prints). */
	value: number | null;
	of: number | null;
}

/** The render step's phase, from its render run's row (options.phase and stages), or picking before it starts. */
export function renderNow(r: RenderRun | null): RenderNow {
	const now = (phase: RenderNow['phase'], sentence: string, value: number | null = null, of: number | null = null): RenderNow => ({
		phase,
		sentence,
		value,
		of
	});
	if (!r) return now('picking', 'Picking the prints to render.');
	if (r.state === 'starting') return now('queueing', 'Queueing the prints to render.');
	switch (r.options.phase ?? null) {
		case 'thumbnails': {
			const label = r.upload_target ? 'Making and uploading thumbnails' : 'Making thumbnails';
			const t = r.options.stages ? stageTotals(r.options.stages) : null;
			if (!t?.thumbsOf) return now('thumbnails', `${label}.`);
			return now('thumbnails', `${label}: ${int(t.thumbsDone)} of ${int(t.thumbsOf)} prints.`, t.thumbsDone, t.thumbsOf);
		}
		case 'uploads': {
			const left = r.uploads_pending;
			return now('uploads', left ? `Uploading the last ${int(left)} page${left === 1 ? '' : 's'}.` : 'Uploading the last pages.');
		}
		case 'deletions':
			return now('deletions', 'Removing replaced files from the bucket.');
		case 'flags': {
			const f = r.options.stages?.flags;
			const stage = f?.stage ?? r.upload_target ?? 'the stage';
			return now(
				'flags',
				f?.state === 'failed'
					? `Setting the search flags on ${stage} failed: run render:flags by hand.`
					: `Setting the search flags on ${stage}.`
			);
		}
		default:
			if (!r.prints_total) return now('picking', 'Picking the prints to render.');
			return now('drawing', `Drawing prints: ${int(r.prints_done)} of ${int(r.prints_total)}.`, r.prints_done, r.prints_total);
	}
}

// --- the board

const reachOf = (cells: Cell[]) => {
	let reach = -1;
	cells.forEach((c, i) => {
		if (c.kind !== 'wait' && c.kind !== 'na') reach = i;
	});
	return reach;
};
/** The Shared row's cells cut to the board's lines; the summary has its title and at most two lines. */
const fitShared = (s: Shared): Shared => ({
	sizing: fitCell(s.sizing),
	summary: { title: s.summary.title, lines: s.summary.lines.slice(0, CELL_LINES - 1) },
	cleanup: fitCell(s.cleanup),
	flags: fitCell(s.flags)
});
const byColumn = (cells: Cell[]) => Object.fromEntries(COLUMNS.map((c, i) => [c, cells[i]])) as Record<ColumnId, Cell>;

/**
 * The board for the page: the live update when one runs (or stopped responding); before an update, when the last
 * check found something, what it found (nothing to the right has run); else the last update's results.
 */
export function buildFlow(o: {
	plan: SyncPlan | null;
	run: SyncRun | null;
	phase: UpdateState;
	/** The latest render run (live or not): a finished render step's figures when it names this run. */
	latestRender: RenderRun | null;
	/** The live render run, if any: a running render step's figures. */
	liveRender?: RenderRun | null;
	progress: LogProgress | null;
	/** The settings on the page, for the run's summary before an update (a run keeps its own). */
	settings?: SyncSettings | null;
	now: number;
	clock: (at: number) => string;
}): Flow {
	const live = o.phase === 'running' || o.phase === 'crashed';
	const mode: BoardMode = live ? 'live' : o.phase === 'waiting' || o.phase === 'blocked' || !o.run ? 'before' : 'last';
	const run = mode === 'before' ? null : o.run;
	const current = live ? (run?.steps.find((s) => s.status === 'running')?.id ?? null) : null;
	const progress = live ? o.progress : null;
	const ago = o.plan ? o.clock(o.plan.checkedAt) : '';
	const { stages, row } = stagesFor(run, o.latestRender, o.liveRender ?? null);
	const settings = mode === 'before' ? (o.settings ?? null) : (run?.options.settings ?? o.settings ?? null);
	const retrying = !!settings?.retryFailed;
	const rows: Row[] = ROWS.map(({ site, plan: match }) => {
		const plan = o.plan?.sources.find(match) ?? null;
		const name = plan?.site ?? site;
		const info = SOURCE_SITES[(name === 'uploads' ? 'upload' : name) as Site];
		const polled = POLLED_SITES.find((p) => p.site === name);
		const held =
			mode === 'before' && plan?.blocked ? { reason: plan.blocked, site: plan.site, id: plan.to.id, polled: !!plan.polled } : null;
		// A held-back source's Accept button takes the room of two lines in its Changes cell.
		const cells = [
			fitCell(changesCell(mode, run, name, plan, progress, ago), held ? 1 : CELL_LINES),
			...[addedCell(mode, run, name, progress), authorsCell(mode, run, name), shotsCell(mode, run, name, progress)].map((c) => fitCell(c)),
			...renderCells(mode, run, name, stages, row, retrying).map((c) => fitCell(c))
		];
		const gate = groupOf(stepOf(run, 'ingest'), (t) => t === GROUP.gate(name));
		return {
			site: name,
			tip:
				name === 'factorioprints'
					? 'factorioprints.com, read from its GitHub mirror; new and edited prints go through the backfill.'
					: name === 'uploads'
						? 'Prints uploaded on this site, admitted as they’re posted.'
						: `${info?.name ?? name}, polled for new and changed prints (about one request a second).`,
			toggle: polled && mode === 'before' ? polled.site : null,
			plan,
			held,
			cells: byColumn(cells),
			reach: reachOf(cells),
			newPrints: valueOf(gate, ROW.newPrints) ?? (live && progress?.step === 'ingest' ? (progress.sites[name]?.new ?? 0) : 0)
		};
	});
	// A site only the render run drew (factoriobin: added by hand) gets a row of its own, render cells only.
	for (const key of Object.keys(stages?.sites ?? {})) {
		if (ROWS.some((r) => stageKey(r.site) === key)) continue;
		const na = cell('na', [], 'Added by hand on the Add page: not part of the update’s fetch.');
		const cells = [
			na,
			na,
			na,
			cell('na', [], 'No screenshot to copy.'),
			...renderCells(mode, run, key, stages, row, retrying).map((c) => fitCell(c))
		];
		rows.push({
			site: key,
			tip: `${SOURCE_SITES[key as Site]?.name ?? key}: prints added by hand, rendered with the rest.`,
			toggle: null,
			plan: null,
			held: null,
			cells: byColumn(cells),
			reach: reachOf(cells),
			newPrints: 0
		});
	}
	const at = current ? stepNo(current) : 0;
	const caption =
		mode === 'before'
			? { lead: 'Before an update:', rest: 'what the last check found; nothing to the right has run yet' }
			: live
				? { lead: 'This update', rest: at ? `· step ${at} of ${SYNC_STEPS.length}` : '' }
				: { lead: 'Last update', rest: `· ${run!.state} ${o.clock(run!.finished_at ?? run!.updated_at)}` };
	return {
		mode,
		live,
		current,
		caption,
		rows,
		shared: fitShared({ sizing: sizingCell(mode, run, progress), ...sharedRender(mode, run, settings, stages, row, o.now) }),
		threads: settings?.workers ?? null,
		renderNow: current === 'render' ? renderNow(row) : null,
		newPrints: rows.reduce((n, r) => n + r.newPrints, 0)
	};
}

/** The cell running now in a column outside the Render group, if any (at most one). */
const runningIn = (flow: Flow, col: ColumnId) => flow.rows.find((r) => r.cells[col].kind === 'run');

/** The calm sentence at the top: what is happening now, or what an update would do. */
export function nowSentence(flow: Flow, o: { plan: SyncPlan | null; phase: UpdateState }): string {
	if (o.phase === 'crashed') return 'The update stopped responding.';
	if (flow.live) {
		switch (flow.current) {
			case 'removals':
				return 'Sweeping this machine’s copies of removed prints.';
			case 'fetch': {
				const r = runningIn(flow, 'changes');
				const n = r?.cells.changes.facts[0]?.n;
				if (r && n !== undefined) return `Reading ${r.site}: ${n}, about one a second.`;
				return r ? `Fetching ${r.site}.` : 'Fetching the sources.';
			}
			case 'ingest': {
				const r = runningIn(flow, 'added');
				const n = r?.cells.added.facts[0]?.n;
				if (r && r.site !== 'factorioprints' && n !== undefined) return `Adding ${r.site} prints through the gate: ${n}.`;
				return 'Analysing factorioprints’ new and edited prints (the backfill).';
			}
			case 'authors':
				return 'Naming new factorioprints authors.';
			case 'screenshots': {
				if (flow.shared.sizing.kind === 'run') return 'Sizing the new screenshots and putting them in the bucket.';
				const r = runningIn(flow, 'shots');
				return r ? `Copying screenshots: ${r.site}.` : 'Copying screenshots.';
			}
			case 'render':
				return flow.renderNow?.sentence ?? 'Picking the prints to render.';
			case 'figures':
				return 'Counting what the site has.';
			default:
				return 'Starting the update.';
		}
	}
	const held = o.plan?.sources.filter((p) => p.blocked) ?? [];
	if (held.length)
		return `${held.map((p) => p.site).join(' and ')} ${held.length === 1 ? 'is' : 'are'} held back: too much changed at once.`;
	const parts: string[] = [];
	for (const r of flow.rows) {
		const p = r.plan;
		if (!p || p.off || p.error || !sourceMoved(p)) continue;
		if (p.ingestsItself) parts.push(`${int(p.added)} upload${p.added === 1 ? '' : 's'} waiting`);
		else if (p.polled) parts.push(`${int(toRead(p))} to read from ${r.site}`);
		else parts.push(`${int(p.added)} new on ${r.site}`);
	}
	if (parts.length) return `Ready: ${parts.join(', ')}.`;
	return 'Up to date: nothing new on any source.';
}

/**
 * The top box's thin bar while a step runs: an honest fraction, or null. Render: prints finished of the prints the
 * run picked (then, after the last page, prints whose thumbnails are done); the fetch and the gate: the running
 * source's reads or admissions; screenshots: other sites' images copied of those to copy.
 */
export function heroBar(flow: Flow, progress: LogProgress | null): number | null {
	if (!flow.live) return null;
	if (flow.current === 'render') {
		const r = flow.renderNow;
		return r && r.of ? pct(r.value ?? 0, r.of) : null;
	}
	const col: ColumnId | null = flow.current === 'fetch' ? 'changes' : flow.current === 'ingest' ? 'added' : null;
	if (col) return runningIn(flow, col)?.cells[col].bar ?? null;
	if (flow.current === 'screenshots' && progress?.step === 'screenshots' && progress.shots.toCopy) {
		const done = Object.values(progress.shots.bySite).reduce((n, s) => n + s.fetched + s.failed, 0);
		return flow.rows.some((r) => r.cells.shots.kind === 'run' || r.cells.shots.kind === 'part') ? pct(done, progress.shots.toCopy) : null;
	}
	return null;
}
