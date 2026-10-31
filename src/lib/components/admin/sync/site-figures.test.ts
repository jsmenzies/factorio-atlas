import { describe, expect, test } from 'bun:test';
import type { SiteRender } from '#lib/server/admin/render-scope.js';
import type { SourceFigures, SyncFigures } from '#lib/sync.js';
import { figureAttention, r2Panel, siteTable, size } from './site-figures';

const src = (o: Partial<SourceFigures>): SourceFigures => ({
	prints: 0,
	folded: 0,
	analysed: 0,
	named: 0,
	shot: 0,
	posts: 0,
	dupOther: 0,
	dupSame: 0,
	unreadable: null,
	...o
});
const render = (o: Partial<SiteRender>): SiteRender => ({
	total: 0,
	rendered: 0,
	none: 0,
	failed: 0,
	left: 0,
	pages: 0,
	bytes: 0,
	older: 0,
	...o
});
const figures = (sources: Record<string, SourceFigures>, more: Partial<SyncFigures> = {}): SyncFigures => ({
	at: 1,
	stage: 'prod',
	prints: 0,
	analysed: {},
	failed: 0,
	unnamed: 0,
	rendered: 0,
	screenshots: {},
	sources,
	...more
});

describe('the Overview’s table by source', () => {
	const f = figures({
		upload: src({ prints: 1, analysed: 1, named: 1, shot: 1, posts: 1 }),
		codex: src({ unreadable: 0 }),
		fprints: src({ prints: 405, analysed: 405, named: 0, shot: 366, posts: 430, dupOther: 20, dupSame: 5, unreadable: 2 }),
		factorioprints: src({
			prints: 18026,
			folded: 125,
			analysed: 18026,
			named: 18026,
			shot: 18023,
			posts: 18046,
			dupOther: 20,
			unreadable: 180
		}),
		factoriobin: src({ prints: 2, analysed: 2, posts: 3, dupOther: 1 })
	});
	const table = siteTable(f, {
		factorioprints: render({ total: 5767, rendered: 5433, none: 334, pages: 60624, bytes: 9e9, older: 12259 }),
		codex: render({ total: 1, left: 1 })
	})!;

	test('sites in a fixed order, the render queue’s sites too; n/a where a column doesn’t apply', () => {
		expect(table.rows.map((r) => r.site)).toEqual(['factorioprints', 'codex', 'fprints', 'factoriobin', 'upload']);
		const fp = table.rows[0];
		expect(fp).toMatchObject({ listed: 17901, pulled: 18226, unreadable: 180, named: 18026, namedOf: 18026 });
		expect(table.rows[3]).toMatchObject({ named: null, namedOf: 0, shot: null, shotOf: 0, pulled: 3 });
		expect(table.rows[1]).toMatchObject({ prints: 0, render: { total: 1, left: 1 } });
	});

	test('the total leaves n/a cells out of their denominators', () => {
		expect(table.total).toMatchObject({
			prints: 18434,
			listed: 18309,
			named: 18027,
			namedOf: 18432,
			shot: 18390,
			shotOf: 18432,
			unreadable: 182
		});
		expect(table.total.render).toMatchObject({ total: 5768, rendered: 5433, left: 1, pages: 60624, older: 12259 });
	});

	test('a site whose unreadable posts aren’t known here: the total and the tile say so', () => {
		const g = figures({ factorioprints: src({ prints: 1, unreadable: 3 }), codex: src({ prints: 1 }) });
		expect(siteTable(g, {})!.rows.map((r) => r.unreadable)).toEqual([3, null]);
		expect(siteTable(g, {})!.total.unreadable).toBeNull();
		expect(figureAttention(g, 0).find((i) => i.key === 'unreadable')).toMatchObject({ n: undefined, flag: false });
		// Sites nothing records them for count 0.
		expect(siteTable(figures({ factoriobin: src({ prints: 1 }) }), {})!.total.unreadable).toBe(0);
	});

	test('no table before the figures had sources', () => {
		expect(siteTable(figures({}, { sources: undefined }), {})).toBeNull();
	});

	test('needs a look: actionable figures past their thresholds', () => {
		// fprints gives no names (left out); unreadable posts are shown, never flagged.
		const items = figureAttention({ ...f, unusedShots: 99 }, 49);
		expect(items.map((i) => [i.key, i.n, i.flag])).toEqual([
			['unnamed', 0, false],
			['waiting', 49, true],
			['unreadable', 182, false],
			['unusedShots', 99, false]
		]);
		const g = figures({ ...f.sources, codex: src({ prints: 396, named: 227, unreadable: 0 }) });
		const unnamed = figureAttention(g, 0)[0];
		expect([unnamed.n, unnamed.flag, unnamed.detail]).toEqual([169, true, 'factoriocodex.com 169']);
		expect(figureAttention(null, 0).map((i) => i.n)).toEqual([undefined, 0, undefined, undefined]);
	});
});

describe('R2 storage', () => {
	test('each bucket’s cost and the total; a bucket with no reading has none', () => {
		const p = r2Panel([
			{ kind: 'renders', name: 'r', objects: 4, bytes: 200e9 },
			{ kind: 'raw', name: 'w', objects: 1, bytes: 4e9 }
		]);
		expect(p).toMatchObject({ objects: 5, bytes: 204e9, missing: 0 });
		expect(r2Panel([{ kind: 'sprites', name: 's', objects: null, bytes: null }])).toMatchObject({ objects: 0, bytes: 0, missing: 1 });
		expect(p.dollars).toBeCloseTo(3.06);
		expect(p.buckets.map((b) => b.dollars)).toEqual([3, 0.06]);
		expect(r2Panel([{ kind: 'sprites', name: 's', objects: null, bytes: null }]).buckets[0].dollars).toBeNull();
		expect([size(0), size(4e5), size(12.15e6), size(204.09e9)]).toEqual(['0 MB', '1 MB', '12 MB', '204.1 GB']);
	});
});
