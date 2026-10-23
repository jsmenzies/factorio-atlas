import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { fixtureRecord } from './fixtures';
import { d1FromSqlite } from './pipeline/d1-sqlite';
import { ingestText, type IngestOutcome } from './pipeline/pipeline';
import { RawStore } from './pipeline/raw-store';
import { PrintRepository, PrintRepositoryD1, RENDER_TOKEN } from './pipeline/repository';
import { syncRenderFlags } from './pipeline/render-flags';
import { analysisKey, parsePrintDoc } from './pipeline/print-doc';
import { applyNameFixes, authorRowStatements, loadAuthorState, planNameFixes, recordNames, unknownAuthors } from './pipeline/authors';
import { syncViews } from './views';
import { MAX_PAGES, matchExpression, MULTI_FILTERS, PAGE_SIZE, searchStatements, type MultiFilter, type SearchParams } from './queries';

const ROOT = join(import.meta.dirname, '../../..');
const SCIENCE = '-KnQ865j-qQ21WoUPbd3'; // Tileable science book, 0.17, claims 0.15–2.0, tagged tileable
const SPACE = '-OlVj1waoXiKkzrQnFss'; // Space Age platform making space science, 2.0.72
const BELTS = '-KjZ17-ZfirKJBYRQT9X'; // 65-page balancer book, 0.15

/** The real migrations, the real pipeline and repository, three real prints (from the mirror, see ./fixtures.ts). */
const setup = async () => {
	const sqlite = new Database(':memory:');
	for (const f of readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.sort()) {
		sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
	}
	const r2 = new Map<string, string>();
	const layer = Layer.mergeAll(
		PrintRepositoryD1(d1FromSqlite(sqlite)),
		Layer.succeed(RawStore, {
			put: (k, v) => Effect.sync(() => void r2.set(k, v)),
			get: (k) => Effect.succeed(r2.get(k) ?? null),
			delete: (k) => Effect.sync(() => void r2.delete(k))
		})
	);
	const outcomes: IngestOutcome[] = [];
	for (const id of [SCIENCE, SPACE, BELTS]) {
		const text = await fixtureRecord(id);
		outcomes.push(await Effect.runPromise(ingestText(id, text, 'test').pipe(Effect.provide(layer))));
	}
	await Effect.runPromise(
		Effect.gen(function* () {
			yield* (yield* PrintRepository).rebuildFacets();
		}).pipe(Effect.provide(layer))
	);
	return { sqlite, outcomes, layer, r2 };
};

const { sqlite, outcomes, layer, r2 } = await setup();
const db = d1FromSqlite(sqlite);

/** Search params; a filter given as one string is that one value. */
type TestParams = Partial<Omit<SearchParams, MultiFilter> & Record<MultiFilter, string | string[]>>;
const params = (p: TestParams): SearchParams => ({
	q: '',
	spaceAge: null,
	circuits: false,
	trains: false,
	render: false,
	author: null,
	sort: 'favorites',
	page: 1,
	...p,
	...(Object.fromEntries(MULTI_FILTERS.map((k) => [k, p[k] === undefined ? [] : [p[k]].flat()])) as Record<MultiFilter, string[]>)
});

const run = (p: TestParams) => {
	const st = searchStatements(params(p));
	const all = (s: { sql: string; binds: unknown[] }) => sqlite.query(s.sql).all(...(s.binds as string[])) as Record<string, unknown>[];
	return {
		ids: all(st.results).map((r) => r.id as string),
		total: all(st.total)[0].n as number,
		makes: Object.fromEntries(all(st.makes).map((r) => [r.value as string, r.n as number])),
		uses: Object.fromEntries(all(st.uses).map((r) => [r.value as string, r.n as number])),
		versions: all(st.versions).map((r) => r.value as string)
	};
};

describe('search over the slim schema', () => {
	test('every fixture was analysed, at a handful of rows each', () => {
		expect(outcomes.map((o) => o.status)).toEqual(['analysed', 'analysed', 'analysed']);
		for (const o of outcomes) if (o.status === 'analysed') expect(o.rowsWritten < 60).toBe(true);
	});

	test('no filters: every print, most favourited first, sidebar from facet_counts', () => {
		const r = run({});
		expect(r.ids).toEqual([SCIENCE, BELTS, SPACE]);
		expect(r.makes['item:automation-science-pack']).toBe(1);
		expect(r.makes['item:space-science-pack']).toBe(1);
	});

	test('the total counts every match; pages past the results are empty', () => {
		expect([run({}).total, run({ spaceAge: 'no' }).total, run({ makes: 'item:nothing-makes-this' }).total]).toEqual([3, 2, 0]);
		expect(run({ page: 2 }).ids).toEqual([]);
		expect(run({ spaceAge: 'no', page: 2 })).toMatchObject({ ids: [], total: 2 });
	});

	test('page n skips the first n − 1 pages, and never goes past MAX_PAGES', () => {
		expect(searchStatements(params({ page: 3 })).results.sql.endsWith(`LIMIT ${PAGE_SIZE} OFFSET ${2 * PAGE_SIZE}`)).toBe(true);
		expect(searchStatements(params({ q: 'belt', page: 2 })).results.sql.endsWith(`LIMIT ${PAGE_SIZE} OFFSET ${PAGE_SIZE}`)).toBe(true);
		expect(searchStatements(params({ page: 500 })).results.sql.endsWith(`OFFSET ${(MAX_PAGES - 1) * PAGE_SIZE}`)).toBe(true);
	});

	test('makes, Space Age, tag and version filters', () => {
		expect(run({ makes: 'item:automation-science-pack' }).ids).toEqual([SCIENCE]);
		expect(run({ spaceAge: 'yes' }).ids).toEqual([SPACE]);
		expect(run({ spaceAge: 'no' }).ids).toEqual([SCIENCE, BELTS]);
		expect(run({ tag: '/general/tileable/' }).ids).toEqual([SCIENCE]);
		// 0.15: the belt book is saved in 0.15.12; the science book claims 0.15 in its tags.
		expect(run({ version: '0.15' }).ids).toEqual([SCIENCE, BELTS]);
		expect(run({ version: '2.0' }).ids).toEqual([SCIENCE, SPACE]);
		expect(run({ version: '2.0.72' }).ids).toEqual([SPACE]);
		expect(run({ version: 'nonsense' }).ids).toEqual([]);
		// Several values of one filter narrow: a print must match each.
		expect(run({ version: ['0.15', '2.0'] }).ids).toEqual([SCIENCE]);
		expect(run({ version: ['0.15', '2.0'] }).versions).toContain('0.15');
		expect(run({ makes: ['item:automation-science-pack', 'item:space-science-pack'] }).ids).toEqual([]);
	});

	test('text and filters combine in one match', () => {
		expect(run({ q: 'science' }).ids.sort()).toEqual([SCIENCE, SPACE].sort());
		expect(run({ q: 'science', spaceAge: 'yes' }).ids).toEqual([SPACE]);
		expect(run({ q: 'science', sort: 'relevance' }).ids.length).toBe(2);
		expect(matchExpression(params({ q: 'red sci', spaceAge: 'no' }))).toBe(
			'{title description labels entities recipes nicknames author} : ("red"* "sci"*) AND facets : "sa_no"'
		);
	});

	test('filtered sidebar counts are exact over the matches', () => {
		const r = run({ spaceAge: 'no' });
		expect(r.makes['item:automation-science-pack']).toBe(1);
		expect(r.makes['item:space-science-pack']).toBe(undefined);
		expect(r.versions.includes('0.15')).toBe(true);
		expect(run({ spaceAge: 'yes' }).versions).toEqual(['2.0']);
	});

	test('uses: curated buildings and any other entity, combined with everything else', () => {
		expect(run({ uses: 'entity:foundry' }).ids).toEqual([SPACE]);
		expect(run({ uses: 'entity:assembling-machine-2' }).ids).toEqual([SCIENCE]);
		// Not a "Built with" building, but every entity is indexed.
		expect(run({ uses: 'entity:fast-splitter' }).ids).toEqual([SCIENCE]);
		expect(run({ uses: 'entity:express-splitter' }).ids).toEqual([BELTS]);
		expect(run({ uses: 'entity:biolab' }).ids).toEqual([]);
		expect(run({ uses: 'entity:express-splitter', spaceAge: 'no', version: '0.15', q: 'blue' }).ids).toEqual([BELTS]);
		expect(run({ uses: 'entity:express-splitter', q: 'science' }).ids).toEqual([]);
		expect(run({ uses: 'entity:beacon', makes: 'item:space-science-pack' }).ids).toEqual([SPACE]);
		expect(matchExpression(params({ uses: 'entity:foundry' }))).toBe('facets : "uses_entity_foundry"');
	});

	test('recipe and module tokens', () => {
		expect(run({ recipe: 'casting-iron' }).ids).toEqual([SPACE]);
		expect(run({ recipe: 'automation-science-pack' }).ids).toEqual([SCIENCE]);
		expect(run({ module: 'productivity-module-3' }).ids).toEqual([SPACE]);
		expect(run({ module: 'speed-module' }).ids).toEqual([]);
	});

	test('"Built with" counts: unfiltered from facet_counts, filtered exact over the matches', () => {
		const all = run({}).uses;
		expect(all['entity:foundry']).toBe(1);
		expect(all['entity:assembling-machine-2']).toBe(1);
		// Only curated buildings are counted; belts and splitters never show up.
		expect(all['entity:fast-splitter']).toBe(undefined);
		expect(run({ spaceAge: 'no' }).uses).toEqual({ 'entity:assembling-machine-2': 1 });
		expect(run({ uses: 'entity:foundry' }).uses['entity:thruster']).toBe(1);
		expect(run({ uses: 'entity:foundry' }).uses['entity:assembling-machine-2']).toBe(undefined);
	});

	test('a quote in the text cannot break the FTS expression', () => {
		expect(run({ q: '"science' }).ids.sort()).toEqual([SCIENCE, SPACE].sort());
	});
});

describe('only prints with a render', () => {
	const facetsOf = (id: string) =>
		(sqlite.query('SELECT facets FROM print_search WHERE print_id = ?').get(id) as { facets: string }).facets.split(' ');
	const flags = () => sqlite.query('SELECT print_id, pages FROM print_renders ORDER BY print_id').all();
	const reingest = (id: string) =>
		fixtureRecord(id).then((text) => Effect.runPromise(ingestText(id, text, 'test', { force: true }).pipe(Effect.provide(layer))));

	test('the token joins every filter in the one match', () => {
		expect(matchExpression(params({ render: true }))).toBe(`facets : "${RENDER_TOKEN}"`);
		expect(matchExpression(params({ q: 'red sci', render: true }))).toBe(
			`{title description labels entities recipes nicknames author} : ("red"* "sci"*) AND facets : "${RENDER_TOKEN}"`
		);
	});

	test('flagging prints sets the token; the filter alone and combined', async () => {
		expect(run({ render: true }).ids).toEqual([]);
		// A print that isn't ingested yet keeps its row for when it is.
		const r = await syncRenderFlags(
			db,
			new Map([
				[SPACE, 3],
				[BELTS, 1],
				['-not-ingested', 2]
			])
		);
		expect(r.plan.upsert.length).toBe(3);
		expect(r.plan.tag.length).toBe(2);
		expect(r.flagged).toBe(3);
		expect(r.searchable).toBe(2);
		expect(facetsOf(SPACE)[0]).toBe(RENDER_TOKEN);
		expect(run({ render: true }).ids).toEqual([BELTS, SPACE]);
		expect(run({ render: true, sort: 'recent' }).ids.sort()).toEqual([BELTS, SPACE].sort());
		expect(run({ render: true, q: 'science' }).ids).toEqual([SPACE]);
		expect(run({ render: true, spaceAge: 'no' }).ids).toEqual([BELTS]);
		// The sidebar counts only the matches.
		expect(run({ render: true }).makes['item:automation-science-pack']).toBe(undefined);
		expect(run({ render: true }).makes['item:space-science-pack']).toBe(1);
		// Unfiltered results are unchanged and carry the card mark.
		const cards = sqlite.query(searchStatements(params({})).results.sql).all() as { id: string; has_render: number }[];
		expect(cards.map((c) => [c.id, c.has_render])).toEqual([
			[SCIENCE, 0],
			[BELTS, 1],
			[SPACE, 1]
		]);
	});

	test('a second sync writes nothing; a page count change only updates the row', async () => {
		const same = await syncRenderFlags(
			db,
			new Map([
				[SPACE, 3],
				[BELTS, 1],
				['-not-ingested', 2]
			])
		);
		expect(same.rowsWritten).toBe(0);
		const more = await syncRenderFlags(
			db,
			new Map([
				[SPACE, 4],
				[BELTS, 1],
				['-not-ingested', 2]
			])
		);
		expect(more.plan).toEqual({ upsert: [[SPACE, 4]], remove: [], tag: [], untag: [] });
	});

	test('a re-ingest keeps the token while the row exists', async () => {
		const before = facetsOf(SPACE);
		expect((await reingest(SPACE)).status).toBe('analysed');
		expect(facetsOf(SPACE)).toEqual(before);
		expect(facetsOf(SPACE).filter((t) => t === RENDER_TOKEN).length).toBe(1);
		expect((await reingest(SCIENCE)).status).toBe('analysed');
		expect(facetsOf(SCIENCE).includes(RENDER_TOKEN)).toBe(false);
		expect(run({ render: true }).ids).toEqual([BELTS, SPACE]);
	});

	test('unflagging removes the row and the token, and nothing else', async () => {
		const before = facetsOf(BELTS).filter((t) => t !== RENDER_TOKEN);
		const r = await syncRenderFlags(db, new Map([[SPACE, 4]]));
		expect(r.plan.remove).toEqual(['-not-ingested', BELTS].sort());
		expect(r.plan.untag.length).toBe(1);
		expect(facetsOf(BELTS)).toEqual(before);
		expect(flags()).toEqual([{ print_id: SPACE, pages: 4 }]);
		expect(run({ render: true }).ids).toEqual([SPACE]);
		// The token never matches as free text (it lives only in `facets`).
		expect(run({ q: 'render_yes' }).ids).toEqual([]);
	});

	test('a dry run plans without writing', async () => {
		const r = await syncRenderFlags(db, new Map(), { dryRun: true });
		expect(r.plan.remove).toEqual([SPACE]);
		expect(r.rowsWritten).toBe(0);
		expect(run({ render: true }).ids).toEqual([SPACE]);
	});
});

describe('query plans', () => {
	const cases: TestParams[] = [
		{},
		{ sort: 'recent' },
		{ q: 'science', sort: 'relevance' },
		{ makes: 'item:automation-science-pack' },
		{ uses: 'entity:foundry' },
		{ q: 'belt', spaceAge: 'no', version: '2.0', sort: 'recent' },
		{ q: 'science', uses: 'entity:beacon', module: 'speed-module-3', sort: 'relevance' },
		{ render: true },
		{ render: true, sort: 'recent' },
		{ q: 'science', render: true, sort: 'relevance' },
		{ render: true, spaceAge: 'yes', uses: 'entity:foundry' },
		{ sort: 'popular' },
		{ q: 'science', makes: 'item:automation-science-pack', sort: 'popular' },
		{ author: 'h5YXabc' },
		{ q: 'science', author: 'h5YXabc', sort: 'recent' }
	];

	test('no search query scans a whole table', () => {
		for (const c of cases) {
			const st = searchStatements(params(c));
			for (const s of [st.results, st.total, st.makes, st.uses, st.versions]) {
				const plan = (sqlite.query(`EXPLAIN QUERY PLAN ${s.sql}`).all(...(s.binds as string[])) as { detail: string }[]).map(
					(r) => r.detail
				);
				// "SCAN p" alone is a full table scan; index scans, FTS and json_each are fine.
				const fullScans = plan.filter((d) => /^SCAN \w+$/.test(d));
				expect({ case: c, fullScans }).toEqual({ case: c, fullScans: [] });
			}
		}
	});
});

describe('views (bun run views:sync)', () => {
	const UNKNOWN = 'AAAAAAAAAAAAAAAAAAAA';

	test('the sync sets counts, writes nothing the second time, and "popular" orders by them', async () => {
		const first = await syncViews(
			db,
			new Map([
				[BELTS, 5],
				[SPACE, 9],
				[UNKNOWN, 3]
			])
		);
		expect(first.plan.set.length).toBe(3);
		// The print that isn't ingested here is planned but matches no row.
		expect(first).toMatchObject({ known: 2, rowsWritten: 2 });
		expect(run({ sort: 'popular' }).ids).toEqual([SPACE, BELTS, SCIENCE]);
		expect(run({ spaceAge: 'no', sort: 'popular' }).ids).toEqual([BELTS, SCIENCE]);
		const again = await syncViews(
			db,
			new Map([
				[BELTS, 5],
				[SPACE, 9],
				[UNKNOWN, 3]
			])
		);
		expect(again.plan).toEqual({ set: [[UNKNOWN, 3]], clear: [] });
		expect(again.rowsWritten).toBe(0);
	});

	test('a print with no views in the window goes back to 0; equal counts fall back to favourites', async () => {
		const done = await syncViews(db, new Map([[SPACE, 9]]));
		expect(done.plan).toEqual({ set: [], clear: [BELTS] });
		expect(run({ sort: 'popular' }).ids).toEqual([SPACE, SCIENCE, BELTS]);
		await syncViews(db, new Map());
		expect(run({ sort: 'popular' }).ids).toEqual(run({}).ids);
	});

	test('a re-ingest keeps the count', async () => {
		await syncViews(db, new Map([[BELTS, 4]]));
		const text = await fixtureRecord(BELTS);
		await Effect.runPromise(ingestText(BELTS, text, 'test', { force: true }).pipe(Effect.provide(layer)));
		expect(sqlite.query('SELECT views_30d FROM prints WHERE id = ?').get(BELTS)).toEqual({ views_30d: 4 });
		await syncViews(db, new Map());
	});
});

describe('authors (bun run authors)', () => {
	const authorOf = (id: string) => (sqlite.query('SELECT author_id FROM prints WHERE id = ?').get(id) as { author_id: string }).author_id;
	/** An R2Bucket over the setup's documents, for applyNameFixes. */
	const bucket = {
		get: async (k: string) => (r2.has(k) ? { text: async () => r2.get(k)! } : null),
		put: async (k: string, v: string) => void r2.set(k, v)
	} as unknown as R2Bucket;

	test("a record's own name is on its card, its document and the authors table, and typed text finds it", () => {
		expect(sqlite.query('SELECT author_name FROM prints WHERE id = ?').get(SPACE)).toEqual({ author_name: 'Pet111' });
		expect(sqlite.query('SELECT display_name, source FROM authors WHERE author_id = ?').get(authorOf(SPACE))).toEqual({
			display_name: 'Pet111',
			source: 'record'
		});
		expect(run({ q: 'pet111' }).ids).toEqual([SPACE]);
		expect(run({ q: 'pet' }).ids).toEqual([SPACE]);
	});

	test('?author= is the by_ token: alone, with text, and an id nobody has', () => {
		expect(run({ author: authorOf(SPACE) }).ids).toEqual([SPACE]);
		expect(run({ author: authorOf(SCIENCE), q: 'science' }).ids).toEqual([SCIENCE]);
		expect(run({ author: authorOf(SCIENCE), spaceAge: 'yes' }).ids).toEqual([]);
		expect(run({ author: 'nobody1234' }).ids).toEqual([]);
		expect(matchExpression(params({ author: 'AbC9' }))).toBe('facets : "by_abc9"');
	});

	test('names from Firebase reach the card, the search row and the document, once', async () => {
		const state = await loadAuthorState(db);
		expect(recordNames(state)).toEqual([]);
		expect(unknownAuthors(state).sort()).toEqual([authorOf(SCIENCE), authorOf(BELTS)].sort());
		// What a Firebase lookup would bring back: a name for one, none for the other.
		await db.batch(
			authorRowStatements(
				db,
				[
					[authorOf(SCIENCE), 'Factorio Fan'],
					[authorOf(BELTS), null]
				],
				'firebase'
			)
		);
		const after = await loadAuthorState(db);
		expect(unknownAuthors(after)).toEqual([]);
		const fixes = planNameFixes(after);
		expect(fixes.map((f) => [f.id, f.name])).toEqual([[SCIENCE, 'Factorio Fan']]);
		const done = await applyNameFixes(db, bucket, fixes);
		expect(done.docsWritten).toBe(1);
		expect(parsePrintDoc(r2.get(analysisKey(SCIENCE))!)?.print.author_name).toBe('Factorio Fan');
		expect(sqlite.query('SELECT author_name FROM prints WHERE id = ?').get(SCIENCE)).toEqual({ author_name: 'Factorio Fan' });
		expect(run({ q: 'factorio fan' }).ids).toEqual([SCIENCE]);
		expect(planNameFixes(await loadAuthorState(db))).toEqual([]);
		expect((await applyNameFixes(db, bucket, fixes)).docsWritten).toBe(0);
	});

	test('a re-ingest keeps the name from the authors table', async () => {
		// A fresh repository, as a new run would have: it reads the authors table once.
		const fresh = Layer.mergeAll(
			PrintRepositoryD1(db),
			Layer.succeed(RawStore, {
				put: (k, v) => Effect.sync(() => void r2.set(k, v)),
				get: (k) => Effect.succeed(r2.get(k) ?? null),
				delete: (k) => Effect.sync(() => void r2.delete(k))
			})
		);
		const text = await fixtureRecord(SCIENCE);
		await Effect.runPromise(ingestText(SCIENCE, text, 'test', { force: true }).pipe(Effect.provide(fresh)));
		expect(sqlite.query('SELECT author_name FROM prints WHERE id = ?').get(SCIENCE)).toEqual({ author_name: 'Factorio Fan' });
		expect(parsePrintDoc(r2.get(analysisKey(SCIENCE))!)?.print.author_name).toBe('Factorio Fan');
		expect(run({ q: 'factorio fan' }).ids).toEqual([SCIENCE]);
		expect(run({ author: authorOf(SCIENCE) }).ids).toEqual([SCIENCE]);
	});
});

describe('page cache purges (meta.sync_version)', () => {
	const version = () => (sqlite.query(`SELECT value FROM meta WHERE key = 'sync_version'`).get() as { value: string } | null)?.value;
	const changes = async (fn: () => Promise<unknown>) => {
		sqlite.run(`UPDATE meta SET value = 'before' WHERE key = 'sync_version'`);
		await fn();
		return version() !== 'before';
	};

	test('render:flags, the views sync and the authors run bump it when they change something, and only then', async () => {
		expect(await changes(() => syncRenderFlags(db, new Map([[SPACE, 1]])))).toBe(true);
		expect(await changes(() => syncRenderFlags(db, new Map([[SPACE, 1]])))).toBe(false);
		expect(await changes(() => syncRenderFlags(db, new Map([[SPACE, 1]]), { dryRun: true }))).toBe(false);
		await syncRenderFlags(db, new Map());
		expect(await changes(() => syncViews(db, new Map([[BELTS, 7]])))).toBe(true);
		expect(await changes(() => syncViews(db, new Map([[BELTS, 7]])))).toBe(false);
		await syncViews(db, new Map());
		const bucket = { get: async () => null, put: async () => {} } as unknown as R2Bucket;
		expect(await changes(() => applyNameFixes(db, bucket, []))).toBe(false);
		sqlite.query(`UPDATE prints SET author_name = NULL WHERE id = ?`).run(BELTS);
		sqlite
			.query(
				`INSERT OR REPLACE INTO authors (author_id, display_name, source, fetched_at) SELECT author_id, 'Belt Fan', 'firebase', 0 FROM prints WHERE id = ?`
			)
			.run(BELTS);
		expect(await changes(async () => applyNameFixes(db, bucket, planNameFixes(await loadAuthorState(db))))).toBe(true);
	});
});
