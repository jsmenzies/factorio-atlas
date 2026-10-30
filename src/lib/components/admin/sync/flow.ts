/**
 * The Update tab's flow: one lane per source (factorioprints, codex, fprints, uploads) through Waiting → Read →
 * Gate, then the shared Screenshots and Render stages, built only from what the page has: the sources' plan
 * (sync_meta 'plan'), the update running now or the last one (its `sources` and its steps' DetailGroups), the
 * render run in progress, and the log's live counts (#lib/sync-progress.js). A figure the update doesn't record
 * per source is shown once, on the shared stage, never split. Pure and browser-safe.
 */
import type { RenderRun } from '#lib/server/admin/render.js';
import type { LogProgress, RenderLog, RenderLogPhase } from '#lib/sync-progress.js';
import { recordsSeen } from '#lib/sync-progress.js';
import { SOURCE_SITES } from '#lib/sources.js';
import type { Site } from '#lib/print-id.js';
import {
	POLLED_READS_PER_UPDATE,
	POLLED_SITES,
	sourceMoved,
	SYNC_STEPS,
	type DetailGroup,
	type DetailRow,
	type PolledSiteId,
	type SourcePlan,
	type SyncPlan,
	type SyncRun,
	type SyncStep,
	type SyncStepId
} from '#lib/sync.js';
import { duration, int } from '../metrics.js';
import { shortCommit, type UpdateState } from './view.js';

export type StageState = 'todo' | 'active' | 'done' | 'warn' | 'bad' | 'held' | 'skip' | 'off';

/** One figure on a stage; `tone` colours it (an outcome, or something to look at). */
export interface Fig {
	label: string;
	value: number | string;
	tone?: 'warn' | 'bad';
}

/** How a site's records came through the gate (the polled admission's counts, or the log's while it runs). */
export interface Outcome {
	of: number;
	new: number;
	joined: number;
	other: number;
	suggest: number;
	unreadable: number;
	failed: number;
}

export interface Stage {
	state: StageState;
	/** The stage's main number, and what it is out of when it has a total. */
	value?: number | null;
	of?: number | null;
	text?: string;
	figs?: Fig[];
	outcome?: Outcome | null;
}

export interface Lane {
	site: string;
	/** What the site is called ("factoriocodex.com"), and the source's kind from the plan ("factoriocodex.com API"). */
	host: string;
	kind: string;
	/** A polled site's switch. */
	toggle: PolledSiteId | null;
	/** How its records reach the gate. */
	via: string;
	plan: SourcePlan | null;
	waiting: Stage;
	read: Stage;
	gate: Stage;
	/** factorioprints only: the authors step. */
	authors: Stage | null;
}

export interface ShotInput {
	key: 'imgur' | 'uploads' | 'sites';
	label: string;
	/** The lanes it takes its images from. */
	sites: string[];
	stage: Stage;
	/** Other sites' images copied so far, per site, while the step runs (the log's lines). */
	live?: { site: string; fetched: number; failed: number }[];
}

export interface Flow {
	live: boolean;
	/** The step running now (live), else null. */
	current: SyncStepId | null;
	/** "This update" while one runs, else "Last update · finished 01:14", or null with no update yet. */
	caption: string | null;
	lanes: Lane[];
	shots: { stage: Stage; inputs: ShotInput[]; sizing: Stage };
	render: Stage;
	/** While the render step runs: its run's phase and progress, for the board, the step's row and the sentence. */
	renderNow: RenderNow | null;
	/** Prints the gate made new on the site in this (or the last) update, as far as recorded. */
	newPrints: number;
}

const LANES: { site: string; plan: (p: SourcePlan) => boolean }[] = [
	{ site: 'factorioprints', plan: (p) => !p.polled && !p.ingestsItself },
	...POLLED_SITES.map(({ site }) => ({ site, plan: (p: SourcePlan) => p.site === site })),
	{ site: 'uploads', plan: (p) => !!p.ingestsItself }
];

const stepOf = (run: SyncRun | null, id: SyncStepId) => run?.steps.find((s) => s.id === id);
const groupOf = (step: SyncStep | undefined, match: (title: string) => boolean): DetailGroup | undefined =>
	step?.details?.find((g) => g.title !== undefined && match(g.title));
const valueOf = (g: DetailGroup | undefined, label: string): number | undefined => {
	const v = g?.rows.find((r) => r.label === label)?.value;
	return typeof v === 'number' ? v : undefined;
};
const figs = (g: DetailGroup | undefined, skip: string[] = []): Fig[] =>
	(g?.rows ?? [])
		.filter((r: DetailRow) => !r.muted && !skip.includes(r.label))
		.map((r) => ({ label: r.label, value: r.value, ...(r.tone ? { tone: r.tone } : {}) }));
const some = (...f: Fig[][]) => f.flat().filter((x) => x.value !== 0 && x.value !== '0');
const fig = (label: string, value: number | undefined | null, tone?: Fig['tone']): Fig[] =>
	value ? [{ label, value, ...(tone ? { tone } : {}) }] : [];

/** A step that didn't run, said in a few words: its summary ("turned off in the settings", "needs …"). */
const skipped = (step: SyncStep | undefined): Stage => ({ state: step?.status === 'failed' ? 'bad' : 'skip', text: step?.summary ?? '' });

/** What a polled site would read now: its new, changed and gone prints, up to the built-in cap. */
const toRead = (p: SourcePlan) => Math.min(p.added + p.edited + p.deleted.length, POLLED_READS_PER_UPDATE);

function waitingStage(p: SourcePlan | null, site: string): Stage {
	if (!p) return { state: 'todo', text: 'not checked yet' };
	if (p.off) return { state: 'off', text: 'off' };
	if (p.error) return { state: 'bad', text: `couldn’t check: ${p.error}` };
	if (p.blocked) return { state: 'held', text: 'held back', value: p.polled ? p.deleted.length : null };
	if (!sourceMoved(p))
		return {
			state: 'skip',
			text: p.polled
				? `up to date · ${int(p.prints)} on the site`
				: site === 'uploads'
					? 'none waiting'
					: `up to date · ${shortCommit(p.to.id)}`
		};
	if (p.ingestsItself) return { state: 'done', value: p.added, text: p.position ?? 'waiting' };
	if (p.polled)
		return {
			state: 'done',
			value: toRead(p),
			text: [`${int(p.added)} new`, `${int(p.edited)} changed`, ...(p.deleted.length ? [`${int(p.deleted.length)} gone?`] : [])].join(
				' · '
			),
			figs: fig('of them left from the last update', p.left)
		};
	return {
		state: 'done',
		value: p.added + p.edited,
		text: `${int(p.added)} new · ${int(p.edited)} edited`,
		figs: [...fig('favourite counts', p.favourites), ...fig('deleted', p.deleted.length, 'warn'), ...fig('commits', p.behind)]
	};
}

/** What the run's fetch did for a site (or is doing: the log's count while it reads). */
function readStage(run: SyncRun | null, site: string, plan: SourcePlan | null, progress: LogProgress | null, live: boolean): Stage {
	const fetch = stepOf(run, 'fetch');
	if (!run || !fetch) return { state: 'todo' };
	const entry = run.sources.find((s) => s.site === site);
	if (entry?.blocked) return { state: 'held', text: `held back: ${entry.blocked}` };
	if (fetch.status === 'pending') return { state: 'todo', text: live ? 'next' : '' };
	if (entry?.polled) {
		const c = entry.counts;
		if (!c) {
			if (fetch.status !== 'running') return { state: 'skip', text: plan?.off ? 'off' : 'nothing new' };
			const of = plan && !plan.off && sourceMoved(plan) ? toRead(plan) : null;
			if (!of) return { state: 'skip', text: 'nothing new' };
			// Reading now, or waiting for the sites before it (one request a second each).
			const seen = progress?.step === 'fetch' ? recordsSeen(progress, site) : 0;
			const s = progress?.sites[site] ?? {};
			return seen
				? { state: 'active', value: seen, of, figs: some(fig('new', s.new), fig('changed', s.changed), fig('failed', s.failed, 'bad')) }
				: { state: 'todo', of, text: 'waiting its turn' };
		}
		const failed = c.failed ?? 0;
		return {
			state: failed ? 'warn' : 'done',
			value: c['records read'],
			figs: some(
				fig('new', c.new),
				fig('changed', c.changed),
				fig('gone from the site', c['gone from the site'], 'warn'),
				fig('failed', failed, 'bad'),
				fig('left for the next update', c.left, 'warn')
			)
		};
	}
	const g = groupOf(fetch, (t) => t === site);
	if (fetch.status === 'running' && !g) {
		// Its entry is written before its fetch; the plan (saved before the update) says whether it has anything.
		if (!entry) return { state: 'todo', text: 'next' };
		const working =
			plan && !plan.off && !plan.error && sourceMoved(plan) && (entry.ingestsItself ? !entry.counts : entry.from?.id === entry.to?.id);
		if (working) return { state: 'active', text: entry.ingestsItself ? 'admitting the waiting uploads' : 'fetching' };
		return { state: 'skip', text: entry.ingestsItself ? 'none waiting' : `already at its latest (${shortCommit(entry.to?.id)})` };
	}
	if (!entry && fetch.status !== 'running')
		return plan?.error ? { state: 'bad', text: `couldn’t check: ${plan.error}` } : { state: 'skip' };
	if (entry?.ingestsItself) {
		const f = some(figs(g, ['waiting', 'oldest waiting']));
		const admitted = valueOf(g, 'admitted');
		return admitted || f.length
			? { state: f.some((x) => x.tone === 'bad') ? 'warn' : 'done', value: admitted ?? null, figs: f }
			: { state: 'skip', text: 'none waiting' };
	}
	// The mirror: a git fetch, then the backfill reads the clone.
	if (entry && entry.to && entry.from?.id === entry.to.id)
		return { state: 'skip', text: `already at its latest (${shortCommit(entry.to.id)})` };
	return { state: 'done', value: valueOf(g, 'new prints') ?? null, text: 'new prints', figs: some(figs(g, ['position', 'new prints'])) };
}

const outcomeOf = (g: DetailGroup | undefined): Outcome | null =>
	g
		? {
				of: valueOf(g, 'records to admit') ?? 0,
				new: valueOf(g, 'new prints') ?? 0,
				joined: valueOf(g, 'joined an existing print') ?? 0,
				other: (valueOf(g, 'updated') ?? 0) + (valueOf(g, 'unchanged') ?? 0) + (valueOf(g, 'blocked') ?? 0),
				suggest: valueOf(g, 'new, with suggestions to look at') ?? 0,
				unreadable: valueOf(g, 'unreadable') ?? 0,
				failed: valueOf(g, 'failed, tried again next update') ?? 0
			}
		: null;

/** How a site's records went through the gate: the backfill's figures (factorioprints), or the polled admission's. */
function gateStage(run: SyncRun | null, lane: string, progress: LogProgress | null, live: boolean): Stage {
	const ingest = stepOf(run, 'ingest');
	if (!run || !ingest || ingest.status === 'pending') return { state: 'todo', text: live && run ? 'next' : '' };
	if (lane === 'uploads') {
		const read = run.sources.find((s) => s.ingestsItself);
		return { state: 'skip', text: read?.counts && Object.values(read.counts).some(Boolean) ? 'admitted in the fetch' : '' };
	}
	if (lane === 'factorioprints') {
		const g = groupOf(ingest, (t) => !t.includes(':') && t.split(', ').includes(lane));
		if (g) {
			const failed = valueOf(g, 'failed') ?? 0;
			return {
				state: failed ? 'warn' : 'done',
				text: `${int(valueOf(g, 'analysed') ?? 0)} analysed`,
				figs: some(
					figs(g, ['analysed']).filter((f) => f.label !== 'failed'),
					fig('failed', failed, 'bad')
				)
			};
		}
		const why = /^backfill skipped: ([^·]+)/.exec(ingest.summary ?? '')?.[1]?.trim();
		if (why || ingest.status === 'skipped') return { state: 'skip', text: `skipped: ${why ?? ingest.summary ?? ''}` };
		if (ingest.status === 'running')
			return Object.keys(progress?.toAdmit ?? {}).length
				? { state: 'done', text: 'the backfill ran; its figures come at the step’s end' }
				: { state: 'active', text: 'the backfill is reading the clone' };
		return { state: ingest.status === 'failed' ? 'bad' : 'skip', text: ingest.summary ?? '' };
	}
	const g = groupOf(ingest, (t) => t === `${lane}: through the gate`);
	const outcome = outcomeOf(g);
	if (outcome) {
		const bad = outcome.failed + outcome.unreadable;
		return {
			state: bad ? 'warn' : 'done',
			value: outcome.new + outcome.joined + outcome.other + outcome.unreadable + outcome.failed,
			of: outcome.of,
			outcome
		};
	}
	if (ingest.status === 'running' && progress?.step === 'ingest') {
		const of = progress.toAdmit[lane];
		if (of === undefined) {
			const entry = run.sources.find((s) => s.site === lane);
			return entry?.counts?.['records read'] ? { state: 'todo', text: 'waiting its turn' } : { state: 'skip' };
		}
		const s = progress.sites[lane] ?? {};
		const o: Outcome = {
			of,
			new: s.new ?? 0,
			joined: s.joined ?? 0,
			other: (s.updated ?? 0) + (s.unchanged ?? 0) + (s.blocked ?? 0) + (s.identified ?? 0),
			suggest: 0,
			unreadable: s.undecodable ?? 0,
			failed: s.failed ?? 0
		};
		// Sites are admitted one after another: only the last one the log started is still going.
		const admitting = Object.keys(progress.toAdmit).at(-1) === lane;
		const settled = admitting ? 'active' : o.failed + o.unreadable ? 'warn' : 'done';
		return { state: settled, value: recordsSeen(progress, lane), of, outcome: o };
	}
	return ingest.status === 'running' ? { state: 'todo', text: 'after the backfill' } : { state: 'skip' };
}

function authorsStage(run: SyncRun | null): Stage {
	const a = stepOf(run, 'authors');
	if (!run || !a || a.status === 'pending') return { state: 'todo', text: 'factorioprints authors' };
	if (a.status === 'running') return { state: 'active', text: 'naming new authors' };
	if (a.status === 'skipped' || a.status === 'stopped') return skipped(a);
	return { state: a.status === 'failed' ? 'bad' : a.status === 'warning' ? 'warn' : 'done', text: a.summary ?? '' };
}

function shotsStages(run: SyncRun | null, progress: LogProgress | null): Flow['shots'] {
	const step = stepOf(run, 'screenshots');
	const live = step?.status === 'running';
	const input = (title: string, skip: string[] = []): Stage => {
		const g = groupOf(step, (t) => t === title);
		if (g) {
			const f = some(figs(g, skip));
			return { state: f.some((x) => x.tone === 'bad' || x.tone === 'warn') ? 'warn' : 'done', figs: f };
		}
		return { state: live ? 'active' : !step || step.status === 'pending' ? 'todo' : 'skip' };
	};
	const imgur = input('On this machine');
	const uploads = input('From uploads');
	const sites = input('From other sites');
	let liveSites: ShotInput['live'];
	if (live && progress?.step === 'screenshots' && progress.shots.toCopy !== null) {
		liveSites = Object.entries(progress.shots.bySite).map(([site, c]) => ({ site, ...c }));
		const done = liveSites.reduce((n, s) => n + s.fetched + s.failed, 0);
		sites.state = 'active';
		sites.value = done;
		sites.of = progress.shots.toCopy;
	}
	const bucket = groupOf(step, (t) => t.endsWith(' bucket'));
	const cards = groupOf(step, (t) => t === 'Search cards');
	const sizing: Stage = bucket
		? { state: 'done', figs: some(figs(bucket), figs(cards)) }
		: { state: live ? (step?.details?.length ? 'active' : 'todo') : !step || step.status === 'pending' ? 'todo' : 'skip' };
	const stage: Stage =
		!step || step.status === 'pending'
			? { state: 'todo' }
			: step.status === 'skipped' || step.status === 'stopped'
				? skipped(step)
				: { state: step.status === 'running' ? 'active' : step.status === 'warning' ? 'warn' : step.status === 'failed' ? 'bad' : 'done' };
	return {
		stage,
		sizing,
		inputs: [
			{ key: 'imgur', label: 'Imgur', sites: ['factorioprints'], stage: imgur },
			{ key: 'uploads', label: 'Uploads', sites: ['uploads'], stage: uploads },
			{ key: 'sites', label: 'Other sites’ images', sites: POLLED_SITES.map((p) => p.site), stage: sites, live: liveSites }
		]
	};
}

/** What the render step is doing now, and how far it is. */
export interface RenderNow {
	phase: RenderLogPhase | 'picking';
	/** "Drawing prints", "Making thumbnails", … (the step row's lead). */
	label: string;
	/** The board's few words under the count. */
	text: string;
	/** Its count, when it has one ("37 of 50 prints"). */
	value: number | null;
	of: number | null;
	unit: string;
	/** The pages so far: drawn, uploaded, failed (the live run's, else its end line's). */
	figs: Fig[];
	/** The sentence at the top. */
	sentence: string;
	/** `--flags` failed: the step goes on to end with a warning. */
	warn: boolean;
}

/**
 * The render step's phase: the render run's row while it draws (prints finished of its picks), then the log's
 * phase lines (#lib/sync-progress.js) for what comes after the last page, when every count reads "done" but the
 * run still makes and uploads thumbnails, deletes replaced files and sets the stage's search flags.
 */
export function renderNow(liveRender: RenderRun | null, log: RenderLog | null): RenderNow {
	const r = liveRender;
	const ended = log?.ended ?? null;
	const figs = r
		? some(fig('pages drawn', r.rendered), fig('uploaded', r.uploaded), fig('failed', r.failed, 'bad'))
		: ended
			? some(fig('pages drawn', ended.rendered), fig('uploaded', ended.uploaded), fig('failed', ended.failed, 'bad'))
			: [];
	const base = { value: null, of: null, unit: '', figs, warn: false };
	const words = (phase: RenderNow['phase'], label: string, sentence = `${label}.`): RenderNow => ({
		...base,
		phase,
		label,
		text: label.toLowerCase(),
		sentence
	});
	const picking = words('picking', 'Picking the prints with work', 'Picking the prints to render.');
	switch (log?.phase ?? 'drawing') {
		case 'drawing':
			if (!r?.prints_total) return picking;
			return {
				...base,
				phase: 'drawing',
				label: 'Drawing prints',
				text: 'prints drawn',
				value: r.prints_done,
				of: r.prints_total,
				figs: [...figs, ...(r.eta_seconds ? [{ label: 'left', value: `≈ ${duration(r.eta_seconds * 1000)}` }] : [])],
				sentence: `Drawing prints: ${int(r.prints_done)} of ${int(r.prints_total)}.`
			};
		case 'thumbnails': {
			const t = log?.thumbs;
			const label = t?.upload === false ? 'Making thumbnails' : 'Making and uploading thumbnails';
			if (!t) return words('thumbnails', label);
			return {
				...base,
				phase: 'thumbnails',
				label,
				text: t.upload ? 'prints’ thumbnails made and uploaded' : 'prints’ thumbnails made',
				value: t.done,
				of: t.of,
				unit: 'prints',
				sentence: `${label}: ${int(t.done)} of ${int(t.of)} prints.`
			};
		}
		case 'uploads': {
			const left = r?.uploads_pending ?? log?.uploadsLeft ?? null;
			return {
				...words('uploads', 'Uploading the last pages', left ? `Uploading the last ${int(left)} page${left === 1 ? '' : 's'}.` : undefined),
				figs: [...figs, ...fig('to go', left)]
			};
		}
		case 'deletions':
			return words('deletions', 'Removing replaced files', 'Removing replaced files from the bucket.');
		case 'finishing':
			return words('finishing', 'Saving the render run');
		case 'flags': {
			const stage = log?.flags?.stage ?? 'the stage';
			if (!log?.flags?.failed) return words('flags', `Updating search flags on ${stage}`);
			return {
				...words('flags', `Search flags on ${stage} failed`, `Setting the search flags on ${stage} failed: run render:flags by hand.`),
				text: `search flags on ${stage} failed: run render:flags by hand`,
				warn: true
			};
		}
	}
}

function renderStage(run: SyncRun | null, now: RenderNow | null): Stage {
	const step = stepOf(run, 'render');
	if (!run || !step || step.status === 'pending') return { state: 'todo' };
	if (step.status === 'running') {
		if (!now || now.phase === 'picking') return { state: 'active', text: 'picking the prints with work' };
		return {
			state: now.warn ? 'warn' : 'active',
			...(now.of !== null ? { value: now.value, of: now.of } : {}),
			text: now.text,
			...(now.figs.length ? { figs: now.figs } : {})
		};
	}
	if (step.status === 'skipped' || step.status === 'stopped') return skipped(step);
	const thisRun = groupOf(step, (t) => t === 'This run');
	const other = (step.details ?? []).filter((g) => g !== thisRun);
	return {
		state: step.status === 'failed' ? 'bad' : step.status === 'warning' ? 'warn' : 'done',
		value: valueOf(thisRun, 'prints drawn') ?? 0,
		text: 'prints drawn',
		figs: some(
			figs(thisRun, ['prints drawn']),
			other.flatMap((g) =>
				figs(g).map((f) => ({ ...f, label: g.title?.startsWith('Top') ? `${g.title.toLowerCase()}: ${f.label}` : f.label }))
			)
		)
	};
}

/**
 * The flow for the page: the live update when one runs (or stopped responding), else the last update's
 * results beside the plan's Waiting column.
 */
export function buildFlow(o: {
	plan: SyncPlan | null;
	run: SyncRun | null;
	phase: UpdateState;
	liveRender: RenderRun | null;
	progress: LogProgress | null;
	now: number;
	timeZone: string;
	clock: (at: number) => string;
}): Flow {
	const live = o.phase === 'running' || o.phase === 'crashed';
	const run = o.run;
	const current = live ? (run?.steps.find((s) => s.status === 'running')?.id ?? null) : null;
	const progress = live ? o.progress : null;
	const lanes: Lane[] = LANES.map(({ site, plan: match }) => {
		const plan = o.plan?.sources.find(match) ?? null;
		const name = plan?.site ?? site;
		const info = SOURCE_SITES[(name === 'uploads' ? 'upload' : name) as Site];
		const polled = POLLED_SITES.find((p) => p.site === name);
		return {
			site: name,
			host: info?.name ?? name,
			kind: plan?.kind ?? '',
			toggle: polled ? polled.site : null,
			via: name === 'factorioprints' ? 'via the backfill' : name === 'uploads' ? 'admitted in the fetch' : 'via the polled admission',
			plan,
			waiting: waitingStage(plan, name),
			read: readStage(run, name, plan, progress, live),
			gate: gateStage(run, name, progress, live),
			authors: name === 'factorioprints' ? authorsStage(run) : null
		};
	});
	const newPrints = lanes.reduce((n, l) => n + (l.gate.outcome?.new ?? 0), 0);
	const rendering = current === 'render' ? renderNow(o.liveRender, progress?.step === 'render' ? progress.render : null) : null;
	return {
		live,
		current,
		caption: !run ? null : live ? 'This update' : `Last update · ${run.state} ${o.clock(run.finished_at ?? run.updated_at)}`,
		lanes,
		shots: shotsStages(run, progress),
		render: renderStage(run, rendering),
		renderNow: rendering,
		newPrints
	};
}

/** The calm sentence at the top: what is happening now, or what an update would do. */
export function nowSentence(
	flow: Flow,
	o: { plan: SyncPlan | null; run: SyncRun | null; phase: UpdateState; liveRender: RenderRun | null }
): string {
	if (o.phase === 'crashed') return 'The update stopped responding.';
	if (flow.live) {
		switch (flow.current) {
			case 'removals':
				return 'Sweeping this machine’s copies of removed prints.';
			case 'fetch': {
				const reading = flow.lanes.find((l) => l.read.state === 'active');
				if (reading?.read.value !== undefined && reading.read.of)
					return `Reading ${reading.host}: ${int(reading.read.value ?? 0)} of ${int(reading.read.of)}, about one a second.`;
				return reading ? `Fetching ${reading.host}.` : 'Fetching the sources.';
			}
			case 'ingest': {
				const admitting = flow.lanes.find((l) => l.gate.state === 'active' && l.gate.of);
				if (admitting)
					return `Putting ${admitting.host} prints through the gate: ${int(admitting.gate.value ?? 0)} of ${int(admitting.gate.of ?? 0)}.`;
				return 'Analysing factorioprints’ new and edited prints (the backfill).';
			}
			case 'authors':
				return 'Naming new factorioprints authors.';
			case 'screenshots': {
				const s = flow.shots.inputs.find((i) => i.key === 'sites')?.stage;
				return s?.of ? `Copying other sites’ screenshots: ${int(s.value ?? 0)} of ${int(s.of)}.` : 'Copying screenshots.';
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
	for (const l of flow.lanes) {
		const p = l.plan;
		if (!p || p.off || p.error || !sourceMoved(p)) continue;
		if (p.ingestsItself) parts.push(`${int(p.added)} upload${p.added === 1 ? '' : 's'} waiting`);
		else if (p.polled) parts.push(`${int(toRead(p))} to read from ${l.site}`);
		else parts.push(`${int(p.added)} new on ${l.site}`);
	}
	if (parts.length) return `Ready: ${parts.join(', ')}.`;
	return 'Up to date: nothing new on any source.';
}

export const STEP_IDS = SYNC_STEPS.map((s) => s.id);
