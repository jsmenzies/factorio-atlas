import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { fixtureRecord } from './fixtures';
import { d1FromSqlite } from './pipeline/d1-sqlite';
import { ingestText, type IngestOutcome } from './pipeline/pipeline';
import { RawStore } from './pipeline/raw-store';
import { PrintRepository, PrintRepositoryD1 } from './pipeline/repository';
import { matchExpression, searchStatements, type SearchParams } from './queries';

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
	return { sqlite, outcomes };
};

const { sqlite, outcomes } = await setup();

const params = (p: Partial<SearchParams>): SearchParams => ({
	q: '',
	makes: null,
	takes: null,
	uses: null,
	recipe: null,
	module: null,
	version: null,
	tag: null,
	spaceAge: null,
	circuits: false,
	trains: false,
	sort: 'favorites',
	...p
});

const run = (p: Partial<SearchParams>) => {
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

describe('query plans', () => {
	const cases: Partial<SearchParams>[] = [
		{},
		{ sort: 'recent' },
		{ q: 'science', sort: 'relevance' },
		{ makes: 'item:automation-science-pack' },
		{ uses: 'entity:foundry' },
		{ q: 'belt', spaceAge: 'no', version: '2.0', sort: 'recent' },
		{ q: 'science', uses: 'entity:beacon', module: 'speed-module-3', sort: 'relevance' }
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
