/**
 * The render runner's per-source counts (#lib/render-stages.js): `stageTally()` is counted beside each of
 * the run row's own counters (scripts/render-game.ts), by the print's site, and `snapshot()` turns it, with
 * what the run holds in memory (the prints it tracks, the uploader's waiting pages, the thumb step's
 * progress), into the `options.stages` the heartbeat writes. Additive only: nothing here is read back by
 * the run, so no input key or queue decision depends on it. Pure apart from the tally's own state.
 */
import {
	stageSite,
	type CleanupStage,
	type FlagsStage,
	type RenderStages,
	type SiteStages,
	type StageSite,
	type ThumbsStage
} from '#lib/render-stages.js';

/** A page's fate at queueing, or in drawing. */
export type PageCount = 'queued' | 'unchanged' | 'skipped' | 'planFailed' | 'drawn' | 'drawFailed';

interface SiteTally {
	pages: number;
	queued: number;
	unchanged: number;
	skipped: number;
	planFailed: number;
	drawn: number;
	drawFailed: number;
	upPages: number;
	upFiles: number;
	upBytes: number;
}

const empty = (): SiteTally => ({
	pages: 0,
	queued: 0,
	unchanged: 0,
	skipped: 0,
	planFailed: 0,
	drawn: 0,
	drawFailed: 0,
	upPages: 0,
	upFiles: 0,
	upBytes: 0
});

export function stageTally() {
	const sites = new Map<StageSite, SiteTally>();
	const of = (id: string) => {
		const site = stageSite(id);
		let t = sites.get(site);
		if (!t) sites.set(site, (t = empty()));
		return t;
	};
	return {
		/**
		 * One page of print `id` looked at in queueing (`queued`, `unchanged`, `skipped`, `planFailed`: it also
		 * counts in `pages`, as run.total does), or one that ended in drawing (`drawn`, `drawFailed`).
		 */
		page(id: string, what: PageCount) {
			const t = of(id);
			if (what === 'queued' || what === 'unchanged' || what === 'skipped' || what === 'planFailed') t.pages++;
			t[what]++;
		},
		/** One page of `id` up in the bucket, with the objects and bytes it put. */
		up(id: string, files: number, bytes: number) {
			const t = of(id);
			t.upPages++;
			t.upFiles += files;
			t.upBytes += bytes;
		},
		/** The counts so far, by site (a copy). */
		get sites(): ReadonlyMap<StageSite, Readonly<SiteTally>> {
			return new Map([...sites].map(([k, v]) => [k, { ...v }]));
		}
	};
}
export type StageTally = ReturnType<typeof stageTally>;

export interface SnapshotInput {
	at: number;
	tally: StageTally;
	/** Prints the run works on, those with every queued page final, and those with a page drawn now. */
	tracked: Iterable<string>;
	finished: Iterable<string>;
	drawnPrints: Iterable<string>;
	/**
	 * Uploading: each print's pages waiting to go up, and the print of each failing page; null without --upload.
	 * A finished print with neither counts as all up (`printsUp`).
	 */
	upload: { waiting: Iterable<[string, number]>; failing: Iterable<string> } | null;
	/** The thumb step's progress by site, or null without it. */
	thumbs: ReadonlyMap<StageSite, ThumbsStage> | null;
	cleanup: CleanupStage | null;
	flags: FlagsStage | null;
}

/** `options.stages` for the run row now. Pure. */
export function snapshot(o: SnapshotInput): RenderStages {
	const sites = new Map<StageSite, SiteStages>();
	const at = (site: StageSite) => {
		let s = sites.get(site);
		if (!s) {
			s = {
				plan: { prints: 0, pages: 0, queued: 0, unchanged: 0, skipped: 0, failed: 0 },
				draw: { drawn: 0, failed: 0, left: 0, printsDone: 0, printsDrawn: 0 },
				upload: o.upload ? { pages: 0, files: 0, bytes: 0, waiting: 0, failing: 0, printsUp: 0 } : null,
				thumbs: o.thumbs ? { done: 0, of: 0 } : null
			};
			sites.set(site, s);
		}
		return s;
	};
	for (const [site, t] of o.tally.sites) {
		const s = at(site);
		Object.assign(s.plan, { pages: t.pages, queued: t.queued, unchanged: t.unchanged, skipped: t.skipped, failed: t.planFailed });
		Object.assign(s.draw, { drawn: t.drawn, failed: t.drawFailed, left: Math.max(0, t.queued - t.drawn - t.drawFailed) });
		if (s.upload) Object.assign(s.upload, { pages: t.upPages, files: t.upFiles, bytes: t.upBytes });
	}
	for (const id of o.tracked) at(stageSite(id)).plan.prints++;
	const finished = [...o.finished];
	for (const id of finished) at(stageSite(id)).draw.printsDone++;
	for (const id of o.drawnPrints) at(stageSite(id)).draw.printsDrawn++;
	if (o.upload) {
		const notUp = new Set<string>();
		for (const [id, n] of o.upload.waiting)
			if (n > 0) {
				at(stageSite(id)).upload!.waiting += n;
				notUp.add(id);
			}
		for (const id of o.upload.failing) {
			at(stageSite(id)).upload!.failing++;
			notUp.add(id);
		}
		for (const id of finished) if (!notUp.has(id)) at(stageSite(id)).upload!.printsUp!++;
	}
	if (o.thumbs) for (const [site, t] of o.thumbs) if (t.of) at(site).thumbs = { ...t };
	return { v: 1, at: o.at, sites: Object.fromEntries(sites), cleanup: o.cleanup, flags: o.flags };
}
