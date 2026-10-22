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
import { matchExpression, MULTI_FILTERS, searchStatements, type MultiFilter, type SearchParams } from './queries';

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
	return { sqlite, outcomes, layer };
};

const { sqlite, outcomes, layer } = await setup();
const db = d1FromSqlite(sqlite);

/** Search params; a filter given as one string is that one value. */
type TestParams = Partial<Omit<SearchParams, MultiFilter> & Record<MultiFilter, string | string[]>>;
const params = (p: TestParams): SearchParams => ({
	q: '',
	spaceAge: null,
	circuits: false,
	trains: false,
	render: false,
	sort: 'favorites',
	...p,
	...(Object.fromEntries(MULTI_FILTERS.map((k) => [k, p[k] === undefined ? [] : [p[k]].flat()])) as Record<MultiFilter, string[]>)
});

const run = (p: TestParams) => {
	const st = searchStatements(params(p));
	const all = (s: { sql: string; binds: unknown[] }) => sqlite.query(s.sql).all(...(s.binds as string[])) as Record<string, unknown>[];
	return {
		ids: all(st.results).map((r) => r.id as string),
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
			'{title description labels entities recipes nicknames} : ("red"* "sci"*) AND facets : "sa_no"'
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
			`{title description labels entities recipes nicknames} : ("red"* "sci"*) AND facets : "${RENDER_TOKEN}"`
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
		{ render: true, spaceAge: 'yes', uses: 'entity:foundry' }
	];

	test('no search query scans a whole table', () => {
		for (const c of cases) {
			const st = searchStatements(params(c));
			for (const s of [st.results, st.makes, st.uses, st.versions]) {
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
