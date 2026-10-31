/**
 * The Overview's "What the site has" by source: the stage's figures per credited site (sync_meta 'figures' `sources`)
 * with the local render queue's coverage by site (render-scope.ts SITE_SCOPES_SQL), as table rows and a total, plus
 * the R2 panel's numbers. Pure, tested in site-figures.test.ts.
 */
import type { SiteRender } from '#lib/server/admin/render-scope.js';
import type { Site } from '#lib/print-id.js';
import { SOURCE_SITES } from '#lib/sources.js';
import { POLLED_SITES, R2_STORAGE_PER_GB_MONTH, type R2Bucket, type SourceFigures, type SyncFigures } from '#lib/sync.js';

/** The table's order: the mirror, then the polled sites, then sites added one at a time. Unknown sites go last. */
const ORDER: Site[] = ['factorioprints', 'codex', 'fprints', 'factoriobin', 'upload'];

/** Sites whose unreadable posts are recorded (the ingest's failures, polled ledgers): a null count there is unknown. */
const UNREADABLE_KNOWN = new Set<string>(['factorioprints', ...POLLED_SITES.map((p) => p.site)]);

/** Columns that don't apply to a site, and why (the cell says n/a). */
export const NOT_APPLICABLE: Partial<Record<Site, { author?: string; shot?: string }>> = {
	factoriobin: { author: 'posted anonymously', shot: 'the site has none' }
};
/** Sites whose records carry no author names at all. */
export const NO_NAMES: Partial<Record<Site, string>> = { fprints: 'the site gives none' };

export const siteName = (site: string) => (site === 'upload' ? 'Uploads here' : (SOURCE_SITES[site as Site]?.name ?? site));

export interface SiteRow {
	site: string;
	name: string;
	prints: number;
	listed: number;
	folded: number;
	analysed: number;
	/** null: doesn't apply to the site (NOT_APPLICABLE); `namedOf` is the prints it counts against. */
	named: number | null;
	namedOf: number;
	shot: number | null;
	shotOf: number;
	render: SiteRender;
	/** Posts pulled from the site: live posts plus those that couldn't be read or were refused. */
	pulled: number;
	dupOther: number;
	dupSame: number;
	/** null: not known here (a polled site with no ledger for the stage on this machine). */
	unreadable: number | null;
}

const noRender = (): SiteRender => ({ total: 0, rendered: 0, none: 0, failed: 0, left: 0, pages: 0, bytes: 0, older: 0 });

const rowOf = (site: string, s: SourceFigures, render: SiteRender | undefined): SiteRow => {
	const na = NOT_APPLICABLE[site as Site];
	return {
		site,
		name: siteName(site),
		prints: s.prints,
		listed: s.prints - s.folded,
		folded: s.folded,
		analysed: s.analysed,
		named: na?.author ? null : s.named,
		namedOf: na?.author ? 0 : s.prints,
		shot: na?.shot ? null : s.shot,
		shotOf: na?.shot ? 0 : s.prints,
		render: render ?? noRender(),
		pulled: s.posts + (s.unreadable ?? 0),
		dupOther: s.dupOther,
		dupSame: s.dupSame,
		unreadable: s.unreadable ?? (UNREADABLE_KNOWN.has(site) ? null : 0)
	};
};

/** Rows by site (every site with prints, posts or renders) and their total; null before the figures had sources. */
export function siteTable(figures: SyncFigures | null, render: Record<string, SiteRender>): { rows: SiteRow[]; total: SiteRow } | null {
	const sources = figures?.sources;
	if (!sources) return null;
	const empty: SourceFigures = {
		prints: 0,
		folded: 0,
		analysed: 0,
		named: 0,
		shot: 0,
		posts: 0,
		dupOther: 0,
		dupSame: 0,
		unreadable: null
	};
	const sites = [...new Set([...Object.keys(sources), ...Object.keys(render)])].sort((a, b) => {
		const ia = ORDER.indexOf(a as Site);
		const ib = ORDER.indexOf(b as Site);
		return (ia < 0 ? ORDER.length : ia) - (ib < 0 ? ORDER.length : ib) || a.localeCompare(b);
	});
	const rows = sites.map((site) => rowOf(site, sources[site] ?? empty, render[site]));
	const sum = (f: (r: SiteRow) => number) => rows.reduce((n, r) => n + f(r), 0);
	const total: SiteRow = {
		site: 'total',
		name: 'Total',
		prints: sum((r) => r.prints),
		listed: sum((r) => r.listed),
		folded: sum((r) => r.folded),
		analysed: sum((r) => r.analysed),
		named: sum((r) => r.named ?? 0),
		namedOf: sum((r) => r.namedOf),
		shot: sum((r) => r.shot ?? 0),
		shotOf: sum((r) => r.shotOf),
		render: {
			total: sum((r) => r.render.total),
			rendered: sum((r) => r.render.rendered),
			none: sum((r) => r.render.none),
			failed: sum((r) => r.render.failed),
			left: sum((r) => r.render.left),
			pages: sum((r) => r.render.pages),
			bytes: sum((r) => r.render.bytes),
			older: sum((r) => r.render.older)
		},
		pulled: sum((r) => r.pulled),
		dupOther: sum((r) => r.dupOther),
		dupSame: sum((r) => r.dupSame),
		unreadable: rows.some((r) => r.unreadable === null) ? null : sum((r) => r.unreadable ?? 0)
	};
	return { rows, total };
}

/**
 * Prints with no author name we could do something about, by site: sites whose records carry no names at all
 * (NO_NAMES) and anonymous ones (NOT_APPLICABLE) are left out.
 */
export const unnamedBySite = (rows: SiteRow[]) =>
	rows
		.filter((r) => r.named !== null && r.named < r.namedOf && !NO_NAMES[r.site as Site])
		.map((r) => ({ site: r.site, name: r.name, n: r.namedOf - r.named! }));

/** A size in decimal units, as Cloudflare's dashboard and bill count them: MB under a gigabyte, else GB to a tenth. */
export const size = (bytes: number) =>
	bytes <= 0
		? '0 MB'
		: bytes < 1e9
			? `${Math.max(1, Math.round(bytes / 1e6)).toLocaleString('en-GB')} MB`
			: `${(bytes / 1e9).toFixed(1)} GB`;

export const BUCKET_TEXT: Record<R2Bucket['kind'], { title: string; holds: string }> = {
	renders: { title: 'Renders', holds: 'overviews, zoom tiles, thumbnails, page data' },
	screenshots: { title: 'Screenshots', holds: 'originals and their sizes' },
	raw: { title: 'Records', holds: 'raw records, analysis documents, viewer files' },
	sprites: { title: 'Icons', holds: 'the game’s item icons, one set for every stage' }
};

/** A month of R2 storage for `bytes` at the list price (decimal GB, as billed). */
export const monthlyCost = (bytes: number) => (bytes / 1e9) * R2_STORAGE_PER_GB_MONTH;

/**
 * The R2 table: each bucket with its estimated monthly cost at R2's list price, and the total ("All"); the free
 * 10 GB isn't taken off (it is shared with the account's other buckets). Buckets with no reading add nothing and
 * have no cost; `missing` says how many.
 */
export function r2Panel(buckets: R2Bucket[]) {
	const bytes = buckets.reduce((n, b) => n + (b.bytes ?? 0), 0);
	return {
		buckets: buckets.map((b) => ({ ...b, dollars: b.bytes === null ? null : monthlyCost(b.bytes) })),
		missing: buckets.filter((b) => b.bytes === null).length,
		objects: buckets.reduce((n, b) => n + (b.objects ?? 0), 0),
		bytes,
		dollars: monthlyCost(bytes)
	};
}

/**
 * When a figure from the table becomes worth a look on the Overview (Attention): at or above these. Unreadable posts
 * are shown but never flagged: most are known factorioprints failures every update skips.
 */
export const ATTENTION_AT = { unnamed: 1, waiting: 1, unreadable: Infinity, unusedShots: 100 } as const;

/**
 * The Overview's "Needs a look" items computed from the figures: prints with no author where names could be had
 * (by site), prints waiting to render, posts that couldn't be read (shown, never flagged) and screenshot copies no
 * print shows, each with whether it reaches its threshold. Undefined counts (figures from before sources were
 * counted, or not known here) stay undefined.
 */
export function figureAttention(figures: SyncFigures | null, waiting: number) {
	const table = siteTable(figures, {});
	const unnamed = table ? unnamedBySite(table.rows) : null;
	const items = [
		{
			key: 'unnamed',
			label: 'Prints with no author',
			n: unnamed?.reduce((s, u) => s + u.n, 0),
			detail: unnamed?.map((u) => `${u.name} ${u.n.toLocaleString('en-GB')}`).join(' · ') ?? '',
			href: '#site-title',
			at: ATTENTION_AT.unnamed
		},
		{ key: 'waiting', label: 'Prints waiting to render', n: waiting, detail: '', href: '/admin/render', at: ATTENTION_AT.waiting },
		{
			key: 'unreadable',
			label: 'Posts that couldn’t be read',
			n: table?.total.unreadable ?? undefined,
			detail: '',
			href: '#site-title',
			at: ATTENTION_AT.unreadable
		},
		{
			key: 'unusedShots',
			label: 'Screenshot copies no print shows',
			n: figures?.unusedShots,
			detail: '',
			href: '#site-title',
			at: ATTENTION_AT.unusedShots
		}
	];
	return items.map((i) => ({ ...i, flag: i.n !== undefined && i.n >= i.at }));
}
