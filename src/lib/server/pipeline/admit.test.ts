import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { fixtureRecord } from '#lib/server/fixtures.js';
import { matchExpression, parseSearch, searchStatements } from '#lib/server/queries.js';
import { admitRecord, WORKER_LIMITS } from './admit';
import { d1FromSqlite } from './d1-sqlite';
import { decodeExchangeString, encodeExchangeString } from './decode';
import { removeToken } from './facet-token';
import { FOLDED_TOKEN } from './fold';
import { fingerprintBlockValues, identityPurgeStatements, sourcesOf } from './identity-db';
import { applyPlan, ingestRecord, ingestText, planIngest, refoldAll, syncFold, syncSources } from './pipeline';
import { withSources } from './print-doc';
import { RawStore } from './raw-store';
import { loadIngestStates, PrintRepository, PrintRepositoryD1 } from './repository';
import { sourceGone } from './source-gone';
import { fromFactorioprints, type SourceRecord } from './source-record';

const ROOT = join(import.meta.dirname, '../../../..');
/** All the Belts: one blueprint, hundreds of entities. */
const ID = '-KYpTULTDIvDOsJfgjeS';
const FIXTURE = await fixtureRecord(ID);
/** The tileable science book. */
const BOOK_ID = '-KnQ865j-qQ21WoUPbd3';
const BOOK = await fixtureRecord(BOOK_ID);
/** A made-up factorioprints id for a re-post. */
const COPY_ID = '-ZZcopyOfAllTheBelts';

const setup = () => {
	const sqlite = new Database(':memory:');
	for (const f of readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.sort()) {
		sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
	}
	const db = d1FromSqlite(sqlite);
	const r2 = new Map<string, string>();
	const layer = Layer.mergeAll(
		PrintRepositoryD1(db),
		Layer.succeed(RawStore, {
			put: (k, v) => Effect.sync(() => void r2.set(k, v)),
			get: (k) => Effect.succeed(r2.get(k) ?? null),
			delete: (k) => Effect.sync(() => void r2.delete(k))
		})
	);
	const run = <A, E>(effect: Effect.Effect<A, E, PrintRepository | RawStore>) => Effect.runPromise(Effect.provide(effect, layer));
	const ingest = (id: string, text: string) => run(ingestText(id, text, `test:${id}`));
	const all = <T>(sql: string, ...args: (string | number)[]) => sqlite.query(sql).all(...args) as T[];
	const doc = (id: string) => JSON.parse(r2.get(`analysis/${id}.json`) ?? 'null') as { print: Record<string, unknown> } | null;
	return { sqlite, db, r2, run, ingest, all, doc };
};

const withRecord = (text: string, change: (r: Record<string, unknown>) => void) => {
	const r = JSON.parse(text) as Record<string, unknown>;
	change(r);
	return JSON.stringify(r);
};

const stringOf = (text: string) => (JSON.parse(text) as { blueprintString: string }).blueprintString;

const bin = (siteId: string, blueprintString: string, over: Partial<SourceRecord> = {}): SourceRecord => ({
	site: 'factoriobin',
	siteId,
	url: `https://factoriobin.com/post/${siteId}`,
	title: 'From factoriobin',
	description: null,
	author: { site: 'factoriobin', id: null, name: 'binner' },
	blueprintString,
	image: null,
	uploadedAt: Date.UTC(2026, 9, 1),
	updatedAt: null,
	favorites: null,
	sourceHints: [],
	...over
});

/** The removals migration's block table, as on main once it lands. */
const addBlocks = (sqlite: Database) =>
	sqlite.run(`CREATE TABLE IF NOT EXISTS removal_blocks (kind TEXT NOT NULL, value TEXT NOT NULL, print_id TEXT NOT NULL,
		report_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (kind, value)) WITHOUT ROWID`);

describe('identity rows on ingest', () => {
	test('a factorioprints print gets its source row and every hash; nothing else changes', async () => {
		const h = setup();
		expect((await h.ingest(ID, FIXTURE)).status).toBe('analysed');
		const created = (JSON.parse(FIXTURE) as { createdDate: number }).createdDate;
		const updated = (JSON.parse(FIXTURE) as { lastUpdatedDate: number }).lastUpdatedDate;
		expect((await sourcesOf(h.db, ID)).map((s) => ({ ...s, first_seen: 0 }))).toEqual([
			{
				print_id: ID,
				site: 'factorioprints',
				site_id: ID,
				url: `https://factorioprints.com/view/${ID}`,
				uploaded_at: created,
				first_seen: 0,
				updated_at: updated,
				gone_at: null
			}
		]);
		const kinds = h.all<{ kind: string; n: number }>(
			'SELECT kind, COUNT(*) AS n FROM print_fingerprints WHERE print_id = ? GROUP BY kind ORDER BY kind',
			ID
		);
		expect(kinds).toEqual([
			{ kind: 'page', n: 1 },
			{ kind: 'page_layout', n: 1 },
			{ kind: 'print', n: 1 },
			{ kind: 'print_layout', n: 1 }
		]);
		expect(h.all<{ source: string }>('SELECT source FROM prints WHERE id = ?', ID)).toEqual([{ source: 'factorioprints' }]);
		expect(h.doc(ID)?.print.copy_of).toBeUndefined();
		// Its own source alone: no list in the document (the page reads it from the id).
		expect(h.doc(ID)?.print.sources).toBeUndefined();
		expect((await h.ingest(ID, FIXTURE)).status).toBe('unchanged');
	});

	test('a factorioprints record that names another site is still factorioprints’', async () => {
		const h = setup();
		const spoofed = withRecord(FIXTURE, (r) => (r.source = { site: 'upload', siteId: 'evil000000', url: 'https://evil.example/' }));
		expect((await h.ingest(ID, spoofed)).status).toBe('analysed');
		expect(h.all('SELECT source, raw_key FROM prints')).toEqual([{ source: 'factorioprints', raw_key: `factorioprints/${ID}.json` }]);
		expect((await sourcesOf(h.db, ID)).map((s) => [s.site, s.site_id])).toEqual([['factorioprints', ID]]);
		expect(h.r2.has('upload/evil000000.json')).toBe(false);
		expect(h.r2.get(`factorioprints/${ID}.json`)).not.toContain('evil');
		// The same record without it is the same content: nothing to do.
		expect((await h.ingest(ID, FIXTURE)).status).toBe('unchanged');
	});

	test('a print ingested before migration 0022 gets its identity rows once, alone', async () => {
		const h = setup();
		await h.ingest(BOOK_ID, BOOK);
		const docBefore = h.r2.get(`analysis/${BOOK_ID}.json`);
		const rowsBefore = h.all('SELECT * FROM prints');
		h.sqlite.run('DELETE FROM print_sources');
		h.sqlite.run('DELETE FROM print_fingerprints');
		expect((await loadIngestStates(h.db)).get(BOOK_ID)?.identified).toBe(false);
		expect((await h.ingest(BOOK_ID, BOOK)).status).toBe('identified');
		expect(h.all('SELECT print_id FROM print_sources')).toEqual([{ print_id: BOOK_ID }]);
		expect(h.all<{ n: number }>("SELECT COUNT(*) AS n FROM print_fingerprints WHERE kind = 'page'")[0].n).toBe(9);
		expect(h.r2.get(`analysis/${BOOK_ID}.json`)).toBe(docBefore);
		expect(h.all('SELECT * FROM prints')).toEqual(rowsBefore);
		expect((await loadIngestStates(h.db)).get(BOOK_ID)?.identified).toBe(true);
		expect((await h.ingest(BOOK_ID, BOOK)).status).toBe('unchanged');
	});

	test('an edit keeps the old hashes, no longer current', async () => {
		const h = setup();
		await h.ingest(BOOK_ID, BOOK);
		const book = (await Effect.runPromise(decodeExchangeString(stringOf(BOOK)))) as { blueprint_book: { blueprints: unknown[] } };
		book.blueprint_book.blueprints.pop();
		const reString = await encodeExchangeString(book);
		expect(
			(
				await h.ingest(
					BOOK_ID,
					withRecord(BOOK, (r) => (r.blueprintString = reString))
				)
			).status
		).toBe('analysed');
		const counts = h.all<{ current: number; n: number }>(
			"SELECT current, COUNT(*) AS n FROM print_fingerprints WHERE kind = 'print' GROUP BY current ORDER BY current"
		);
		expect(counts).toEqual([
			{ current: 0, n: 1 },
			{ current: 1, n: 1 }
		]);
	});
});

describe('admitRecord', () => {
	test('an exact copy from another site joins the print; its own source keeps it', async () => {
		const h = setup();
		await h.ingest(ID, FIXTURE);
		const r = await admitRecord(h.db, bin('LYMz5ZJT', stringOf(FIXTURE)));
		expect(r.status).toBe('existing');
		if (r.status !== 'existing') return;
		expect(r.printId).toBe(ID);
		expect(r.via).toBe('exact');
		expect(r.admitted.size > 50).toBe(true);
		const own = await admitRecord(h.db, fromFactorioprints(ID, FIXTURE));
		expect(own).toMatchObject({ status: 'existing', printId: ID, via: 'source' });
	});

	test('a factorioprints re-post of a factorioprints print is new, a copy of the earlier one', async () => {
		const h = setup();
		await h.ingest(ID, FIXTURE);
		const later = withRecord(FIXTURE, (r) => (r.createdDate = (r.createdDate as number) + 86_400_000));
		const r = await admitRecord(h.db, fromFactorioprints(COPY_ID, later));
		expect(r).toMatchObject({ status: 'new', copyOf: ID });
		const earlier = withRecord(FIXTURE, (r) => (r.createdDate = (r.createdDate as number) - 86_400_000));
		expect(await admitRecord(h.db, fromFactorioprints(COPY_ID, earlier))).toMatchObject({ status: 'new', copyOf: null });
	});

	test('under 50 entities and tiles an exact match is only a suggestion', async () => {
		const h = setup();
		const small = await encodeExchangeString({
			blueprint: {
				item: 'blueprint',
				version: 562949954076672,
				entities: Array.from({ length: 6 }, (_, i) => ({ entity_number: i + 1, name: 'solar-panel', position: { x: i * 3 + 1.5, y: 1.5 } }))
			}
		});
		const smallText = withRecord(FIXTURE, (r) => (r.blueprintString = small));
		await h.ingest(ID, smallText);
		const r = await admitRecord(h.db, bin('small001', small));
		expect(r.status).toBe('new');
		if (r.status !== 'new') return;
		expect(r.copyOf).toBeNull();
		expect(r.admitted.suggestions).toEqual([{ kind: 'small-exact', printId: ID, size: 6 }]);
	});

	test('a compilation book holding the print is only a page suggestion, counted both ways', async () => {
		const h = setup();
		await h.ingest(ID, FIXTURE);
		const belts = (await Effect.runPromise(decodeExchangeString(stringOf(FIXTURE)))) as Record<string, unknown>;
		const science = (await Effect.runPromise(decodeExchangeString(stringOf(BOOK)))) as { blueprint_book: { blueprints: unknown[] } };
		const compilation = await encodeExchangeString({
			blueprint_book: {
				item: 'blueprint-book',
				blueprints: [{ ...belts, index: 0 }, ...science.blueprint_book.blueprints.map((p, i) => ({ ...(p as object), index: i + 1 }))]
			}
		});
		const r = await admitRecord(h.db, bin('compil01', compilation));
		expect(r.status).toBe('new');
		if (r.status !== 'new') return;
		expect(r.admitted.suggestions[0]).toMatchObject({ kind: 'pages', printId: ID, shared: 1, ofThat: 1 });
		expect((r.admitted.suggestions[0] as { ofThis: number }).ofThis).toBeGreaterThan(1);
	});

	test('blocks: the source before decoding, any exact hash after', async () => {
		const h = setup();
		addBlocks(h.sqlite);
		h.sqlite.run("INSERT INTO removal_blocks VALUES ('source', 'factoriobin:blocked1', 'x', NULL, 0)");
		expect(await admitRecord(h.db, bin('blocked1', 'not even a blueprint'))).toEqual({ status: 'blocked', by: 'source' });
		await h.ingest(ID, FIXTURE);
		const hashes = await fingerprintBlockValues(h.db, ID);
		// One page: the whole print's hash is the page's.
		expect(hashes.length).toBe(1);
		h.sqlite.query("INSERT INTO removal_blocks VALUES ('sha256', ?, ?, NULL, 0)").run(hashes[0], ID);
		expect(await admitRecord(h.db, bin('free0001', stringOf(FIXTURE)))).toEqual({ status: 'blocked', by: 'sha256' });
		// The backfill's path refuses it too, under another id: tracked, so it isn't analysed again every run.
		expect(await h.ingest(COPY_ID, FIXTURE)).toEqual({ status: 'blocked', id: COPY_ID, by: ID });
		expect(h.all('SELECT status, reason FROM ingest_state WHERE print_id = ?', COPY_ID)).toEqual([
			{ status: 'failed', reason: `blocked: the same blueprint as removed print ${ID}` }
		]);
		expect(h.all('SELECT id FROM prints WHERE id = ?', COPY_ID)).toEqual([]);
		expect(h.r2.has(`factorioprints/${COPY_ID}.json`)).toBe(false);
		expect((await h.ingest(COPY_ID, FIXTURE)).status).toBe('skipped-failed');
		// But the live print the block came from (or any live print that matches one) is ingested as usual.
		const edited = withRecord(FIXTURE, (r) => (r.title = 'All the Belts, edited'));
		expect((await h.ingest(ID, edited)).status).toBe('analysed');
		expect((await h.ingest(ID, edited)).status).toBe('unchanged');
	});

	test('a removed book’s page is refused posted alone, never inside another book', async () => {
		const h = setup();
		addBlocks(h.sqlite);
		const science = (await Effect.runPromise(decodeExchangeString(stringOf(BOOK)))) as {
			blueprint_book: { blueprints: Record<string, unknown>[] };
		};
		const page = science.blueprint_book.blueprints.find((p) => {
			const e = (p.blueprint as { entities?: unknown[] } | undefined)?.entities;
			return (e?.length ?? 0) >= 50;
		})!;
		const { index: _index, ...lone } = page;
		// The removed book's blocks, as a takedown writes them: its whole content and its pages of 50 or more.
		await h.ingest(BOOK_ID, BOOK);
		for (const hash of await fingerprintBlockValues(h.db, BOOK_ID)) {
			h.sqlite.query("INSERT INTO removal_blocks VALUES ('sha256', ?, ?, NULL, 0)").run(hash, BOOK_ID);
		}
		const loneString = await encodeExchangeString(lone);
		const loneText = withRecord(FIXTURE, (r) => (r.blueprintString = loneString));
		expect(await h.ingest(COPY_ID, loneText)).toMatchObject({ status: 'blocked', by: BOOK_ID });
		const belts = (await Effect.runPromise(decodeExchangeString(stringOf(FIXTURE)))) as Record<string, unknown>;
		const holder = await encodeExchangeString({
			blueprint_book: {
				item: 'blueprint-book',
				blueprints: [
					{ ...belts, index: 0 },
					{ ...lone, index: 1 }
				]
			}
		});
		expect(
			(
				await h.ingest(
					'-ZZbookHoldingAPage0',
					withRecord(FIXTURE, (r) => (r.blueprintString = holder))
				)
			).status
		).toBe('analysed');
	});

	test('Worker caps answer too-big; bad strings undecodable', async () => {
		const h = setup();
		const s = stringOf(FIXTURE);
		expect(await admitRecord(h.db, bin('big00001', s), { limits: { ...WORKER_LIMITS, maxStringBytes: 100 } })).toMatchObject({
			status: 'too-big',
			by: 'string',
			limit: 100
		});
		expect(await admitRecord(h.db, bin('big00002', s), { limits: { ...WORKER_LIMITS, maxEntitiesAndTiles: 10 } })).toMatchObject({
			status: 'too-big',
			by: 'entities',
			limit: 10
		});
		expect(await admitRecord(h.db, bin('bad00001', '0abc'))).toMatchObject({ status: 'undecodable' });
	});
});

describe('ingestRecord', () => {
	test('another site’s record: its own source, name and archive key, extra statements in the same batch', async () => {
		const h = setup();
		const record = bin('LYMz5ZJT', stringOf(BOOK), { title: 'Science from the bin' });
		const admitted = await admitRecord(h.db, record);
		expect(admitted.status).toBe('new');
		if (admitted.status !== 'new') return;
		h.sqlite.run('CREATE TABLE uploads_probe (print_id TEXT)');
		const outcome = await h.run(
			ingestRecord(
				record,
				{ ...admitted, printId: 'fbin-LYMz5ZJT' },
				{
					extra: () => [h.db.prepare('INSERT INTO uploads_probe VALUES (?)').bind('fbin-LYMz5ZJT')]
				}
			)
		);
		expect(outcome.status).toBe('analysed');
		expect(h.all('SELECT print_id FROM uploads_probe')).toEqual([{ print_id: 'fbin-LYMz5ZJT' }]);
		expect(h.all('SELECT source, source_url, author_id, author_name, title FROM prints')).toEqual([
			{
				source: 'factoriobin',
				source_url: 'https://factoriobin.com/post/LYMz5ZJT',
				author_id: null,
				author_name: 'binner',
				title: 'Science from the bin'
			}
		]);
		expect(h.r2.has('factoriobin/LYMz5ZJT.json')).toBe(true);
		expect(h.r2.has('factorioprints/fbin-LYMz5ZJT.json')).toBe(false);
		expect(h.doc('fbin-LYMz5ZJT')?.print.author_name).toBe('binner');
		expect(h.all('SELECT COUNT(*) AS n FROM authors')).toEqual([{ n: 0 }]);
		expect(await sourcesOf(h.db, 'fbin-LYMz5ZJT')).toMatchObject([{ site: 'factoriobin', site_id: 'LYMz5ZJT' }]);
		// A factorioprints copy arriving later joins it.
		expect(await admitRecord(h.db, fromFactorioprints(BOOK_ID, BOOK))).toMatchObject({ status: 'existing', printId: 'fbin-LYMz5ZJT' });
	});
});

describe('ingestRecord: first upload wins', () => {
	test('a later source of a print adds its row and hashes only; an earlier one is shown', async () => {
		const h = setup();
		await h.ingest(ID, FIXTURE);
		const docBefore = h.r2.get(`analysis/${ID}.json`);
		const later = bin('later001', stringOf(FIXTURE), { title: 'Reposted', uploadedAt: Date.UTC(2026, 0, 1) });
		const a = await admitRecord(h.db, later);
		expect(a).toMatchObject({ status: 'existing', printId: ID, via: 'exact' });
		if (a.status !== 'existing') return;
		const version = () => h.all<{ value: string }>("SELECT value FROM meta WHERE key = 'sync_version'")[0]?.value;
		const versionBefore = version();
		expect(await h.run(ingestRecord(later, a))).toEqual({ status: 'identified', id: ID });
		// The document gains the sources list and nothing else; cached pages are purged.
		expect(h.doc(ID)?.print.sources).toEqual([
			{ site: 'factorioprints', site_id: ID },
			{ site: 'factoriobin', site_id: 'later001' }
		]);
		expect(withSources(h.r2.get(`analysis/${ID}.json`)!, undefined)).toBe(docBefore!);
		expect(version()).not.toBe(versionBefore);
		expect(h.all('SELECT title, source FROM prints')).toEqual([{ title: 'All the Belts', source: 'factorioprints' }]);
		expect((await sourcesOf(h.db, ID)).map((s) => s.site)).toEqual(['factorioprints', 'factoriobin']);

		const earlier = bin('early001', stringOf(FIXTURE), { title: 'The real first post', uploadedAt: 1 });
		const b = await admitRecord(h.db, earlier);
		if (b.status !== 'existing') throw new Error(b.status);
		expect((await h.run(ingestRecord(earlier, b))).status).toBe('analysed');
		expect(h.all('SELECT id, title, source FROM prints')).toEqual([{ id: ID, title: 'The real first post', source: 'factoriobin' }]);
		// Written before the batch that adds its row, the document lists it first already.
		expect(h.doc(ID)?.print.sources).toEqual([
			{ site: 'factoriobin', site_id: 'early001' },
			{ site: 'factorioprints', site_id: ID },
			{ site: 'factoriobin', site_id: 'later001' }
		]);
		// Nothing left to sync.
		expect(await h.run(syncSources(ID))).toBe(false);
	});
});

describe('first upload wins against the backfill', () => {
	test('a factorioprints record posted minutes after another site’s copy never takes the credit back', async () => {
		const h = setup();
		await h.ingest(ID, FIXTURE);
		const created = (JSON.parse(FIXTURE) as { createdDate: number }).createdDate;
		// The same author posts on fprints ten minutes before factorioprints (the shape of 5 real prints).
		const fprints = (title: string, updatedAt: number): SourceRecord => ({
			site: 'fprints',
			siteId: '66d30661-0000-4000-8000-000000000000',
			url: 'https://fprints.xyz/blueprint/66d30661-0000-4000-8000-000000000000',
			title,
			description: null,
			author: { site: 'fprints', id: 'u1', name: null },
			blueprintString: stringOf(FIXTURE),
			image: null,
			uploadedAt: created - 10 * 60_000,
			updatedAt,
			favorites: null,
			sourceHints: []
		});
		const shown = () => h.all('SELECT title, source FROM prints');
		const first = fprints('Belts, posted on fprints first', created);
		const a = await admitRecord(h.db, first);
		if (a.status !== 'existing') throw new Error(a.status);
		expect((await h.run(ingestRecord(first, a))).status).toBe('analysed');
		expect(shown()).toEqual([{ title: 'Belts, posted on fprints first', source: 'fprints' }]);

		// The backfill comes to the factorioprints record: its text differs from what the print shows, so it is
		// planned and analysed again, but only its source row and hashes are written.
		const state = await h.run(
			Effect.gen(function* () {
				return yield* (yield* PrintRepository).getState(ID);
			})
		);
		const plan = await h.run(planIngest(ID, FIXTURE, 'test', state));
		expect(plan.kind).toBe('analysed');
		expect(await h.run(applyPlan(plan))).toEqual({ status: 'identified', id: ID });
		expect(await h.ingest(ID, FIXTURE)).toEqual({ status: 'identified', id: ID });
		expect(shown()).toEqual([{ title: 'Belts, posted on fprints first', source: 'fprints' }]);
		expect(JSON.parse(h.r2.get(`fprints/${first.siteId}.json`)!).title).toBe('Belts, posted on fprints first');

		// An edit on fprints: still the credited source, so shown.
		const edit = fprints('Belts, edited on fprints', created + 3_600_000);
		const b = await admitRecord(h.db, edit);
		if (b.status !== 'existing') throw new Error(b.status);
		expect((await h.run(ingestRecord(edit, b))).status).toBe('analysed');
		expect(await h.ingest(ID, FIXTURE)).toEqual({ status: 'identified', id: ID });
		expect(shown()).toEqual([{ title: 'Belts, edited on fprints', source: 'fprints' }]);
		expect(h.doc(ID)?.print.sources).toEqual([
			{ site: 'fprints', site_id: first.siteId },
			{ site: 'factorioprints', site_id: ID }
		]);
	});

	test('a factorioprints record that is the only, or the earliest, source is analysed as before', async () => {
		const h = setup();
		expect((await h.ingest(ID, FIXTURE)).status).toBe('analysed');
		const later = bin('later002', stringOf(FIXTURE), { uploadedAt: Date.UTC(2026, 0, 1) });
		const a = await admitRecord(h.db, later);
		if (a.status !== 'existing') throw new Error(a.status);
		await h.run(ingestRecord(later, a));
		expect(
			(
				await h.ingest(
					ID,
					withRecord(FIXTURE, (r) => (r.title = 'Renamed on factorioprints'))
				)
			).status
		).toBe('analysed');
		expect(h.all('SELECT title, source FROM prints')).toEqual([{ title: 'Renamed on factorioprints', source: 'factorioprints' }]);
	});
});

describe('the soft fold', () => {
	/** All the Belts posted again a day later: by its own author, or by someone else. */
	const repost = (by: 'same' | 'other', days = 1) =>
		withRecord(FIXTURE, (r) => {
			r.createdDate = (r.createdDate as number) + days * 86_400_000;
			r.title = `All the Belts (again, ${days})`;
			if (by === 'other') r.author = { userId: 'someoneElse000000000000000001' };
		});
	const ids = (h: ReturnType<typeof setup>, q: Record<string, string>) => {
		const st = searchStatements(parseSearch(new URL(`https://x/?${new URLSearchParams(q)}`))).results;
		return h.all<{ id: string }>(st.sql, ...(st.binds as string[])).map((r) => r.id);
	};
	const folds = (h: ReturnType<typeof setup>) => h.all('SELECT id, duplicate_of, identical_to FROM prints ORDER BY id');
	const OTHER_ID = '-ZZotherAuthorsBelts';
	const THIRD_ID = '-ZZthirdPostOfBelts0';

	test('the same author’s later copy is hidden and points at the original; order of ingest doesn’t matter', async () => {
		for (const order of [
			[ID, COPY_ID],
			[COPY_ID, ID]
		]) {
			const h = setup();
			for (const id of order) await h.ingest(id, id === ID ? FIXTURE : repost('same'));
			expect(folds(h)).toEqual([
				{ id: ID, duplicate_of: null, identical_to: null },
				{ id: COPY_ID, duplicate_of: ID, identical_to: null }
			]);
			expect(h.doc(COPY_ID)?.print.copy_of).toEqual({ id: ID });
			expect(h.doc(ID)?.print.copy_of).toBeUndefined();
			expect(ids(h, {})).toEqual([ID]);
			expect(ids(h, { q: 'belts' })).toEqual([ID]);
			expect(matchExpression(parseSearch(new URL('https://x/?q=belts')))).toContain(FOLDED_TOKEN);
			const total = searchStatements(parseSearch(new URL('https://x/'))).total;
			expect(h.all(total.sql)).toEqual([{ n: 1 }]);
			// Re-analysed, the copy's document has copy_of from its first write.
			const puts: string[] = [];
			const put = h.r2.set.bind(h.r2);
			h.r2.set = (k, v) => (k === `analysis/${COPY_ID}.json` && puts.push(v), put(k, v));
			await h.run(ingestText(COPY_ID, repost('same'), 'test', { force: true }));
			h.r2.set = put;
			expect(puts.map((d) => (JSON.parse(d) as { print: { copy_of?: unknown } }).print.copy_of)).toEqual([{ id: ID }]);
			expect(ids(h, { q: 'belts' })).toEqual([ID]);
		}
	});

	test('someone else’s later copy is folded too, into the group’s earliest; every copy points there', async () => {
		const h = setup();
		await h.ingest(OTHER_ID, repost('other'));
		await h.ingest(COPY_ID, repost('same', 2));
		// The same author's copy points at the earliest, someone else's, until the original comes.
		expect(folds(h)).toEqual([
			{ id: COPY_ID, duplicate_of: OTHER_ID, identical_to: null },
			{ id: OTHER_ID, duplicate_of: null, identical_to: null }
		]);
		await h.ingest(ID, FIXTURE);
		expect(folds(h)).toEqual([
			{ id: ID, duplicate_of: null, identical_to: null },
			{ id: COPY_ID, duplicate_of: ID, identical_to: null },
			{ id: OTHER_ID, duplicate_of: ID, identical_to: null }
		]);
		expect(h.doc(OTHER_ID)?.print.copy_of).toEqual({ id: ID });
		expect(h.doc(OTHER_ID)?.print.identical_to).toBeUndefined();
		expect(ids(h, { q: 'belts' })).toEqual([ID]);
		expect(ids(h, {})).toEqual([ID]);
	});

	test('an old identical_to (the rule before 2026-10-30) is cleared and the copy folded by a refold', async () => {
		const h = setup();
		await h.ingest(ID, FIXTURE);
		await h.ingest(OTHER_ID, repost('other'));
		// As the old rule left the row: listed, noted as identical (a refold rewrites the document from the row).
		await h.db.prepare('UPDATE prints SET duplicate_of = NULL, identical_to = ? WHERE id = ?').bind(ID, OTHER_ID).run();
		await h.db
			.prepare(`UPDATE print_search SET ${removeToken(FOLDED_TOKEN)} WHERE print_id = ?`)
			.bind(OTHER_ID)
			.run();
		expect(ids(h, { q: 'belts' }).sort()).toEqual([ID, OTHER_ID].sort());
		const { members } = await h.run(refoldAll({ bump: true }));
		expect(members.filter((m) => m.changed).map((m) => [m.printId, m.duplicateOf, m.identicalTo])).toEqual([[OTHER_ID, ID, null]]);
		expect(folds(h)).toEqual([
			{ id: ID, duplicate_of: null, identical_to: null },
			{ id: OTHER_ID, duplicate_of: ID, identical_to: null }
		]);
		expect(h.doc(OTHER_ID)?.print).toMatchObject({ copy_of: { id: ID } });
		expect(h.doc(OTHER_ID)?.print.identical_to).toBeUndefined();
		expect(ids(h, { q: 'belts' })).toEqual([ID]);
	});

	test('under 50 entities and tiles nothing is folded or noted, whoever posted it', async () => {
		const h = setup();
		const small = await encodeExchangeString({
			blueprint: {
				item: 'blueprint',
				version: 562949954076672,
				entities: Array.from({ length: 6 }, (_, i) => ({ entity_number: i + 1, name: 'solar-panel', position: { x: i * 3 + 1.5, y: 1.5 } }))
			}
		});
		const smallRepost = (by: 'same' | 'other') =>
			withRecord(repost(by), (r) => {
				r.blueprintString = small;
			});
		await h.ingest(
			ID,
			withRecord(FIXTURE, (r) => (r.blueprintString = small))
		);
		await h.ingest(COPY_ID, smallRepost('same'));
		await h.ingest(OTHER_ID, smallRepost('other'));
		expect(folds(h)).toEqual([
			{ id: ID, duplicate_of: null, identical_to: null },
			{ id: COPY_ID, duplicate_of: null, identical_to: null },
			{ id: OTHER_ID, duplicate_of: null, identical_to: null }
		]);
		expect((await h.run(refoldAll({ bump: false, dryRun: true }))).members).toEqual([]);
	});

	test('a reordered book is not a copy', async () => {
		const h = setup();
		await h.ingest(BOOK_ID, BOOK);
		const book = (await Effect.runPromise(decodeExchangeString(stringOf(BOOK)))) as { blueprint_book: { blueprints: unknown[] } };
		book.blueprint_book.blueprints.reverse();
		const reordered = await encodeExchangeString(book);
		await h.ingest(
			COPY_ID,
			withRecord(BOOK, (r) => {
				r.blueprintString = reordered;
				r.createdDate = (r.createdDate as number) + 1;
			})
		);
		expect(folds(h)).toEqual([
			{ id: BOOK_ID, duplicate_of: null, identical_to: null },
			{ id: COPY_ID, duplicate_of: null, identical_to: null }
		]);
	});

	test('three posts by one author: when the original is edited, fails or is purged, the next one takes over', async () => {
		for (const leave of ['edited', 'failed', 'purged'] as const) {
			const h = setup();
			await h.ingest(ID, FIXTURE);
			await h.ingest(COPY_ID, repost('same', 1));
			await h.ingest(THIRD_ID, repost('same', 2));
			expect(folds(h)).toEqual([
				{ id: ID, duplicate_of: null, identical_to: null },
				{ id: COPY_ID, duplicate_of: ID, identical_to: null },
				{ id: THIRD_ID, duplicate_of: ID, identical_to: null }
			]);
			if (leave === 'edited')
				await h.ingest(
					ID,
					withRecord(FIXTURE, (r) => (r.blueprintString = stringOf(BOOK)))
				);
			else if (leave === 'failed')
				await h.ingest(
					ID,
					withRecord(FIXTURE, (r) => (r.blueprintString = '0nonsense'))
				);
			else {
				const purge = async (id: string) => {
					await h.db.batch([h.db.prepare('DELETE FROM prints WHERE id = ?').bind(id), ...identityPurgeStatements(h.db, id)]);
				};
				const refold = (id: string) => h.run(syncFold(id));
				const resync = (id: string) => h.run(syncSources(id));
				expect(await sourceGone(h.db, 'factorioprints', ID, { purge, resync, refold })).toEqual({ status: 'purged', printId: ID });
			}
			// A print that fails analysis leaves the site too (its prints row goes).
			expect(folds(h)).toEqual([
				...(leave === 'edited' ? [{ id: ID, duplicate_of: null, identical_to: null }] : []),
				{ id: COPY_ID, duplicate_of: null, identical_to: null },
				{ id: THIRD_ID, duplicate_of: COPY_ID, identical_to: null }
			]);
			expect(h.doc(COPY_ID)?.print.copy_of).toBeUndefined();
			expect(h.doc(THIRD_ID)?.print.copy_of).toEqual({ id: COPY_ID });
		}
	});

	test('a backfill hands folds over and refolds once at the end; bun run fold finds nothing left', async () => {
		const h = setup();
		const touched: string[] = [];
		for (const [id, text] of [
			[ID, FIXTURE],
			[COPY_ID, repost('same')]
		] as const) {
			await h.run(
				Effect.gen(function* () {
					const state = yield* (yield* PrintRepository).getState(id);
					return yield* applyPlan(yield* planIngest(id, text, 'test', state), { foldLater: (x) => void touched.push(x) });
				})
			);
		}
		expect(touched).toEqual([ID, COPY_ID]);
		expect(folds(h)).toEqual([
			{ id: ID, duplicate_of: null, identical_to: null },
			{ id: COPY_ID, duplicate_of: null, identical_to: null }
		]);
		const version = () => h.all<{ value: string }>("SELECT value FROM meta WHERE key = 'sync_version'");
		const before = version();
		const first = await h.run(refoldAll({ bump: false }));
		expect(first.members.filter((m) => m.changed).map((m) => m.printId)).toEqual([COPY_ID]);
		expect(first.documents).toBe(1);
		expect(version()).toEqual(before);
		expect(h.doc(COPY_ID)?.print.copy_of).toEqual({ id: ID });
		const again = await h.run(refoldAll({ bump: true, recheck: true }));
		expect(again.members.filter((m) => m.changed)).toEqual([]);
		expect(again.documents).toBe(0);
	});
});

describe('sourceGone', () => {
	test('the only source: purged and refolded; a second, earlier source: handed over; a later one: kept', async () => {
		const h = setup();
		await h.ingest(ID, FIXTURE);
		const purged: string[] = [];
		const refolded: string[] = [];
		const purge = async (id: string) => {
			purged.push(id);
			await h.db.batch([h.db.prepare('DELETE FROM prints WHERE id = ?').bind(id), ...identityPurgeStatements(h.db, id)]);
		};
		const refold = async (id: string) => void refolded.push(id);
		const reingested: string[] = [];
		const reingest = async (id: string, winner: { site: string }) => void reingested.push(`${id}<-${winner.site}`);
		const resync = (id: string) => h.run(syncSources(id));
		const deps = { purge, reingest, resync, refold };
		const listed = () => h.doc(ID)?.print.sources;

		// Two sources: factorioprints (2017) and factoriobin (2026), both on the page.
		h.sqlite
			.query(
				"INSERT INTO print_sources (site, site_id, print_id, url, uploaded_at, first_seen) VALUES ('factoriobin', 'LYMz5ZJT', ?, 'u', ?, 0)"
			)
			.run(ID, Date.UTC(2026, 0, 1));
		expect(await resync(ID)).toBe(true);
		expect(listed()).toEqual([
			{ site: 'factorioprints', site_id: ID },
			{ site: 'factoriobin', site_id: 'LYMz5ZJT' }
		]);
		// The later one goes: the page is back to its own source alone, so the document drops the list.
		expect(await sourceGone(h.db, 'factoriobin', 'LYMz5ZJT', deps)).toEqual({ status: 'kept', printId: ID });
		expect(listed()).toBeUndefined();
		expect(await sourceGone(h.db, 'factoriobin', 'LYMz5ZJT', deps)).toEqual({ status: 'already-gone', printId: ID });
		// Live again, then the credited (earlier) one goes: the page lists only factoriobin.
		h.sqlite.run("UPDATE print_sources SET gone_at = NULL WHERE site = 'factoriobin'");
		expect(await sourceGone(h.db, 'factorioprints', ID, deps)).toMatchObject({ status: 'handed-over', printId: ID });
		expect(reingested).toEqual([`${ID}<-factoriobin`]);
		expect(listed()).toEqual([{ site: 'factoriobin', site_id: 'LYMz5ZJT' }]);
		expect(refolded).toEqual([]);
		expect(await sourceGone(h.db, 'factoriobin', 'LYMz5ZJT', deps)).toEqual({ status: 'purged', printId: ID });
		expect([purged, refolded]).toEqual([[ID], [ID]]);
		// Run again (as after a call cut short before its refold): no second purge, but the refold again.
		expect(await sourceGone(h.db, 'factoriobin', 'LYMz5ZJT', deps)).toEqual({ status: 'purged', printId: ID });
		expect([purged, refolded]).toEqual([[ID], [ID, ID]]);
		expect(await sourceGone(h.db, 'upload', 'nothing000', deps)).toEqual({ status: 'unknown' });
	});
});
