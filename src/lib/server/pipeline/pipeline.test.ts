import { describe, expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import { fixtureRecord } from '#lib/server/fixtures.js';
import { listPages, nodeAt } from '#lib/viewer/extract.js';
import { ANALYZER_VERSION } from './analyze';
import { decodeExchangeString, encodeExchangeString } from './decode';
import { gameData } from './game-data';
import { applyPlan, ingestText, planIngest, type IngestOptions } from './pipeline';
import { RawStore } from './raw-store';
import { INDEX_VERSION, PrintRepository, type IngestState, type StoredPrint } from './repository';
import { legacyPageKey, pageStringKey, parseViewerIndex, VIEWER_VERSION, viewerIndexKey } from './viewer-files';

/** A small real print (1 blueprint), from the mirror (see ../fixtures.ts). */
const ID = '-KYpTULTDIvDOsJfgjeS';
const FIXTURE = await fixtureRecord(ID);
/** A real 10-node book (9 blueprints): the tileable science book. */
const BOOK_ID = '-KnQ865j-qQ21WoUPbd3';
const BOOK = await fixtureRecord(BOOK_ID);

const withRecord = (change: (r: Record<string, unknown>) => void, text = FIXTURE) => {
	const r = JSON.parse(text) as Record<string, unknown>;
	change(r);
	return JSON.stringify(r);
};

const decodeRecord = (text: string) =>
	Effect.runPromise(decodeExchangeString((JSON.parse(text) as { blueprintString: string }).blueprintString));

/** In-memory D1 and R2 stand-ins that count every write. */
const harness = (id = ID) => {
	const states = new Map<string, IngestState>();
	/** Ids an approved removal blocks. */
	const removed = new Set<string>();
	const writes = { rawPuts: 0, upserts: 0, failures: 0, favorites: 0 };
	/** Writes under `viewer/`, and `ingest_state.viewer_version`-only updates. */
	const viewer = { puts: 0, deletes: 0, versions: 0 };
	let analysisPuts = 0;
	let lastUpsert: StoredPrint | null = null;
	/** R2: raw archive puts are counted; analysis documents are kept so the favourites patch can read them. */
	const r2 = new Map<string, string>();
	/** Every key a delete was sent for, whether or not it existed. */
	const deleted: string[] = [];
	const layer = Layer.mergeAll(
		Layer.succeed(RawStore, {
			put: (key, body) =>
				Effect.sync(() => {
					if (key.startsWith('factorioprints/')) writes.rawPuts++;
					if (key.startsWith('viewer/')) viewer.puts++;
					if (key.startsWith('analysis/')) analysisPuts++;
					r2.set(key, body);
				}),
			get: (key) => Effect.succeed(r2.get(key) ?? null),
			delete: (key) =>
				Effect.sync(() => {
					deleted.push(key);
					if (key.startsWith('viewer/') && r2.has(key)) viewer.deletes++;
					r2.delete(key);
				})
		}),
		Layer.succeed(PrintRepository, {
			getState: (id) => Effect.succeed(states.get(id) ?? null),
			identify: () => Effect.void,
			planFold: () => Effect.succeed([]),
			planAllFolds: () => Effect.succeed([]),
			applyFold: () => Effect.void,
			foldState: () => Effect.succeed({ duplicateOf: null, identicalTo: null }),
			sources: () => Effect.succeed([]),
			blocked: () => Effect.succeed(null),
			rebuildFacets: () => Effect.void,
			authorName: () => Effect.succeed(null),
			isRemoved: (id) => Effect.succeed(removed.has(id)),
			upsert: (p) =>
				Effect.sync(() => {
					writes.upserts++;
					lastUpsert = p;
					states.set(p.id, {
						contentSha256: p.contentSha256,
						status: 'ok',
						reason: null,
						analyzerVersion: p.analysis.analyzerVersion,
						gameDataVersion: p.analysis.gameDataVersion,
						viewerVersion: p.viewerVersion,
						indexVersion: INDEX_VERSION,
						favorites: p.record.numberOfFavorites ?? 0
					});
					return 0;
				}),
			recordFailure: (f) =>
				Effect.sync(() => {
					writes.failures++;
					states.set(f.id, {
						contentSha256: f.contentSha256,
						status: 'failed',
						reason: f.reason,
						analyzerVersion: null,
						gameDataVersion: null,
						viewerVersion: null,
						indexVersion: null,
						favorites: f.favorites
					});
				}),
			updateFavorites: (id, favorites) =>
				Effect.sync(() => {
					writes.favorites++;
					const s = states.get(id);
					if (s) states.set(id, { ...s, favorites });
				}),
			setViewerVersion: (id, viewerVersion) =>
				Effect.sync(() => {
					viewer.versions++;
					const s = states.get(id);
					if (s) states.set(id, { ...s, viewerVersion });
				})
		})
	);
	const doc = () => JSON.parse(r2.get(`analysis/${id}.json`) ?? 'null') as { print: { favorites: number } } | null;
	const run = (text: string, options: IngestOptions = {}) =>
		Effect.runPromise(ingestText(id, text, 'test', options).pipe(Effect.provide(layer)));
	/** A backfill's two halves: plan (from the current state), then store. */
	const plan = (text: string) => Effect.runPromise(planIngest(id, text, 'test', states.get(id) ?? null, {}).pipe(Effect.provide(layer)));
	const apply = (p: Awaited<ReturnType<typeof plan>>) => Effect.runPromise(applyPlan(p).pipe(Effect.provide(layer)));
	/** Every viewer object stored for the print. */
	const viewerKeys = () => [...r2.keys()].filter((k) => k.startsWith(`viewer/${id}/`)).sort();
	return {
		run,
		plan,
		apply,
		writes,
		viewer,
		states,
		removed,
		doc,
		r2,
		deleted,
		viewerKeys,
		analysisPuts: () => analysisPuts,
		lastUpsert: () => lastUpsert
	};
};

describe('ingestText change detection', () => {
	test('a new record is analysed, archived and stored', async () => {
		const h = harness();
		expect((await h.run(FIXTURE)).status).toBe('analysed');
		expect(h.writes).toEqual({ rawPuts: 1, upserts: 1, failures: 0, favorites: 0 });
	});

	test('an unchanged record writes nothing', async () => {
		const h = harness();
		await h.run(FIXTURE);
		const viewerPuts = h.viewer.puts;
		expect((await h.run(FIXTURE)).status).toBe('unchanged');
		expect(h.writes).toEqual({ rawPuts: 1, upserts: 1, failures: 0, favorites: 0 });
		expect(h.viewer).toEqual({ puts: viewerPuts, deletes: 0, versions: 0 });
		expect(h.analysisPuts()).toBe(1);
	});

	test('a favourites-only change is one small update, no re-analysis or archive write', async () => {
		const h = harness();
		await h.run(FIXTURE);
		const outcome = await h.run(withRecord((r) => (r.numberOfFavorites = 99999)));
		expect(outcome).toEqual({ status: 'favorites', id: ID, favorites: 99999 });
		expect(h.writes).toEqual({ rawPuts: 1, upserts: 1, failures: 0, favorites: 1 });
		// The print page reads favourites from its R2 document, so that's patched too.
		expect(h.doc()?.print.favorites).toBe(99999);
	});

	test('a content change is re-archived and re-analysed', async () => {
		const h = harness();
		await h.run(FIXTURE);
		expect((await h.run(withRecord((r) => (r.title = 'Renamed')))).status).toBe('analysed');
		expect(h.writes).toEqual({ rawPuts: 2, upserts: 2, failures: 0, favorites: 0 });
	});

	test('an analyzer or game-data version change re-analyses without re-archiving', async () => {
		const h = harness();
		await h.run(FIXTURE);
		const s = h.states.get(ID)!;
		h.states.set(ID, { ...s, analyzerVersion: ANALYZER_VERSION - 1 });
		expect((await h.run(FIXTURE)).status).toBe('analysed');
		h.states.set(ID, { ...h.states.get(ID)!, gameDataVersion: `${gameData.gameVersion}-old` });
		expect((await h.run(FIXTURE)).status).toBe('analysed');
		expect(h.writes).toEqual({ rawPuts: 1, upserts: 3, failures: 0, favorites: 0 });
		// The content didn't change and the viewer files are current, so they aren't rewritten.
		expect(h.viewer).toEqual({ puts: 2, deletes: 0, versions: 0 });
	});

	test('--force re-analyses an unchanged record', async () => {
		const h = harness();
		await h.run(FIXTURE);
		expect((await h.run(FIXTURE, { force: true })).status).toBe('analysed');
	});
});

describe('removed prints', () => {
	test('a print an approved removal blocks is never stored, even forced or changed', async () => {
		const h = harness();
		h.removed.add(ID);
		expect(await h.run(FIXTURE)).toEqual({ status: 'removed', id: ID });
		expect(
			await h.run(
				withRecord((r) => (r.title = 'Renamed')),
				{ force: true }
			)
		).toEqual({ status: 'removed', id: ID });
		expect(h.writes).toEqual({ rawPuts: 0, upserts: 0, failures: 0, favorites: 0 });
		expect(h.viewer.puts).toBe(0);
		expect(h.analysisPuts()).toBe(0);
	});

	test('a removal while a run holds an old plan: the refresh writes nothing either', async () => {
		const h = harness();
		await h.run(FIXTURE);
		h.removed.add(ID);
		expect((await h.run(withRecord((r) => (r.numberOfFavorites = 99999)))).status).toBe('removed');
		expect(h.writes.favorites).toBe(0);
	});

	test('a favourites refresh planned before the approval and stored after leaves no analysis document', async () => {
		const h = harness();
		await h.run(FIXTURE);
		const planned = await h.plan(withRecord((r) => (r.numberOfFavorites = 99999)));
		expect(planned.kind).toBe('refresh');
		// The takedown lands while the run reads the document (so it reads it, then puts it back).
		h.removed.add(ID);
		expect(await h.apply(planned)).toEqual({ status: 'removed', id: ID });
		expect(h.r2.has(`analysis/${ID}.json`)).toBe(false);
	});

	test('an undecodable removed print is not tracked as failed', async () => {
		const h = harness();
		h.removed.add(ID);
		expect((await h.run(withRecord((r) => (r.blueprintString = '0garbage')))).status).toBe('removed');
		expect(h.writes.failures).toBe(0);
	});
});

describe('ingestText failures', () => {
	const broken = withRecord((r) => (r.blueprintString = '0eNotAValidZlibStream'));

	test('a record that cannot be decoded is tracked as failed, not stored', async () => {
		const h = harness();
		const outcome = await h.run(broken);
		expect(outcome.status).toBe('failed');
		expect(h.writes).toEqual({ rawPuts: 1, upserts: 0, failures: 1, favorites: 0 });
		expect(h.states.get(ID)?.reason?.startsWith('decode: ')).toBe(true);
		expect(h.doc()).toBe(null);
	});

	test('a print that stops decoding loses its R2 document, so it leaves the site', async () => {
		const h = harness();
		await h.run(FIXTURE);
		expect(h.doc() === null).toBe(false);
		await h.run(broken);
		expect(h.doc()).toBe(null);
	});

	test('an unchanged failed record is skipped, even if its favourites change', async () => {
		const h = harness();
		await h.run(broken);
		const again = JSON.parse(broken) as Record<string, unknown>;
		again.numberOfFavorites = 12345;
		expect((await h.run(JSON.stringify(again))).status).toBe('skipped-failed');
		expect(h.writes).toEqual({ rawPuts: 1, upserts: 0, failures: 1, favorites: 0 });
	});

	test('--retry-failed tries again; a changed record is retried anyway', async () => {
		const h = harness();
		await h.run(broken);
		expect((await h.run(broken, { retryFailed: true })).status).toBe('failed');
		expect((await h.run(FIXTURE)).status).toBe('analysed');
		expect(h.writes).toEqual({ rawPuts: 2, upserts: 1, failures: 2, favorites: 0 });
	});

	test('an analyze failure from an older analyzer is retried; a decode failure never is', async () => {
		const h = harness();
		await h.run(FIXTURE);
		const s = h.states.get(ID)!;
		h.states.set(ID, { ...s, status: 'failed', reason: `analyze v${ANALYZER_VERSION - 1}: boom` });
		expect((await h.run(FIXTURE)).status).toBe('analysed');
		h.states.set(ID, { ...h.states.get(ID)!, status: 'failed', reason: `analyze v${ANALYZER_VERSION}: boom` });
		expect((await h.run(FIXTURE)).status).toBe('skipped-failed');
	});
});

describe('re-index (INDEX_VERSION)', () => {
	/** As if the print's D1 rows were written by an older index (or before migration 0009). */
	const staleIndex = (h: ReturnType<typeof harness>, id = ID) =>
		h.states.set(id, { ...h.states.get(id)!, indexVersion: INDEX_VERSION - 1 });

	test('rewrites only the D1 rows, from the R2 analysis document, then writes nothing', async () => {
		const h = harness(BOOK_ID);
		await h.run(BOOK);
		const before = new Map(h.r2);
		// Mark the stored analysis, to show the rows come from it and not from a fresh analysis.
		const key = `analysis/${BOOK_ID}.json`;
		const doc = JSON.parse(h.r2.get(key)!) as { analysis: { labels: string[] } };
		doc.analysis.labels = ['from the R2 document'];
		h.r2.set(key, JSON.stringify(doc));
		before.set(key, h.r2.get(key)!);
		staleIndex(h, BOOK_ID);
		h.states.set(BOOK_ID, { ...h.states.get(BOOK_ID)!, indexVersion: null });
		expect(await h.run(BOOK)).toEqual({ status: 'reindexed', id: BOOK_ID, rowsWritten: 0, viewerFiles: 0 });
		expect(h.lastUpsert()?.analysis.labels).toEqual(['from the R2 document']);
		expect(h.states.get(BOOK_ID)?.indexVersion).toBe(INDEX_VERSION);
		// One upsert; no archive, analysis document or viewer writes.
		expect(h.writes).toEqual({ rawPuts: 1, upserts: 2, failures: 0, favorites: 0 });
		expect(h.analysisPuts()).toBe(1);
		expect(h.viewer).toEqual({ puts: 10, deletes: 0, versions: 0 });
		expect(new Map(h.r2)).toEqual(before);
		expect((await h.run(BOOK)).status).toBe('unchanged');
		expect(h.writes.upserts).toBe(2);
	});

	test('takes a favourites change along, patching the R2 document', async () => {
		const h = harness();
		await h.run(FIXTURE);
		staleIndex(h);
		expect((await h.run(withRecord((r) => (r.numberOfFavorites = 777)))).status).toBe('reindexed');
		expect(h.lastUpsert()?.record.numberOfFavorites).toBe(777);
		expect(h.states.get(ID)?.favorites).toBe(777);
		expect(h.doc()?.print.favorites).toBe(777);
		expect(h.writes).toEqual({ rawPuts: 1, upserts: 2, failures: 0, favorites: 0 });
	});

	test('and a VIEWER_VERSION bump in the same pass', async () => {
		const h = harness();
		await h.run(FIXTURE);
		h.states.set(ID, { ...h.states.get(ID)!, viewerVersion: VIEWER_VERSION - 1, indexVersion: null });
		expect(await h.run(FIXTURE)).toEqual({ status: 'reindexed', id: ID, rowsWritten: 0, viewerFiles: 2 });
		expect(h.states.get(ID)?.viewerVersion).toBe(VIEWER_VERSION);
		expect(h.states.get(ID)?.indexVersion).toBe(INDEX_VERSION);
		expect((await h.run(FIXTURE)).status).toBe('unchanged');
	});

	test('a missing analysis document falls back to a full analysis', async () => {
		const h = harness();
		await h.run(FIXTURE);
		h.r2.delete(`analysis/${ID}.json`);
		staleIndex(h);
		expect((await h.run(FIXTURE)).status).toBe('analysed');
		expect(h.analysisPuts()).toBe(2);
		expect(h.doc() === null).toBe(false);
		expect(h.states.get(ID)?.indexVersion).toBe(INDEX_VERSION);
	});
});

describe('viewer files', () => {
	test('list every node in book order, with a string per blueprint and no entity data', async () => {
		const h = harness(BOOK_ID);
		const outcome = await h.run(BOOK);
		expect(outcome.status).toBe('analysed');
		const decoded = await decodeRecord(BOOK);
		const pages = listPages(decoded);
		expect(parseViewerIndex(h.r2.get(viewerIndexKey(BOOK_ID)) ?? null)).toEqual({ v: VIEWER_VERSION, pages });
		const blueprints = pages.filter((p) => p.kind === 'blueprint');
		expect(blueprints.length).toBe(9);
		// Index, plus a string per blueprint; nothing for the book node itself. Entity data comes with the render.
		expect(h.viewerKeys()).toEqual([viewerIndexKey(BOOK_ID), ...blueprints.map((p) => pageStringKey(BOOK_ID, p.path))].sort());
		expect(outcome.status === 'analysed' && outcome.viewerFiles).toBe(10);
	});

	test("each page's string decodes back to that page's body", async () => {
		const h = harness(BOOK_ID);
		await h.run(BOOK);
		const decoded = await decodeRecord(BOOK);
		for (const p of listPages(decoded).filter((n) => n.kind === 'blueprint')) {
			const text = h.r2.get(pageStringKey(BOOK_ID, p.path))!;
			expect(await Effect.runPromise(decodeExchangeString(text))).toEqual({ blueprint: nodeAt(decoded, p.path)!.body });
		}
	});

	test('a single blueprint is stored as the root page', async () => {
		const h = harness();
		await h.run(FIXTURE);
		expect(h.viewerKeys()).toEqual([`viewer/${ID}/index.json`, `viewer/${ID}/root.txt`]);
	});

	test('a VIEWER_VERSION bump rebuilds only the viewer files', async () => {
		const h = harness(BOOK_ID);
		await h.run(BOOK);
		const before = new Map(h.r2);
		// As if the files were written by an older extractor: stale state and index.
		h.states.set(BOOK_ID, { ...h.states.get(BOOK_ID)!, viewerVersion: VIEWER_VERSION - 1 });
		h.r2.set(viewerIndexKey(BOOK_ID), JSON.stringify({ ...JSON.parse(before.get(viewerIndexKey(BOOK_ID))!), v: VIEWER_VERSION - 1 }));
		h.viewer.puts = 0;
		expect(await h.run(BOOK)).toEqual({ status: 'viewer', id: BOOK_ID, viewerFiles: 10 });
		expect(h.writes).toEqual({ rawPuts: 1, upserts: 1, failures: 0, favorites: 0 });
		expect(h.analysisPuts()).toBe(1);
		expect(h.viewer).toEqual({ puts: 10, deletes: 0, versions: 1 });
		expect(h.states.get(BOOK_ID)?.viewerVersion).toBe(VIEWER_VERSION);
		expect(new Map(h.r2)).toEqual(before);
		// Up to date again.
		expect((await h.run(BOOK)).status).toBe('unchanged');
		expect(h.viewer).toEqual({ puts: 10, deletes: 0, versions: 1 });
	});

	test('rebuilding files from version 3 deletes the per-page entity data it kept', async () => {
		const h = harness(BOOK_ID);
		await h.run(BOOK);
		const before = new Map(h.r2);
		const blueprints = parseViewerIndex(before.get(viewerIndexKey(BOOK_ID))!)!.pages.filter((p) => p.kind === 'blueprint');
		// As version 3 left them: an index of that version, and an entity-data JSON per page.
		h.states.set(BOOK_ID, { ...h.states.get(BOOK_ID)!, viewerVersion: 3 });
		h.r2.set(viewerIndexKey(BOOK_ID), JSON.stringify({ ...JSON.parse(before.get(viewerIndexKey(BOOK_ID))!), v: 3 }));
		for (const p of blueprints) h.r2.set(legacyPageKey(BOOK_ID, p.path), '{}');
		expect(h.viewerKeys().length).toBe(1 + 2 * 9);
		expect(await h.run(BOOK)).toEqual({ status: 'viewer', id: BOOK_ID, viewerFiles: 10 });
		expect(h.viewer.deletes).toBe(9);
		expect(new Map(h.r2)).toEqual(before);
	});

	test('after an index of this version, a rebuild sends no deletes for entity data', async () => {
		const h = harness(BOOK_ID);
		await h.run(BOOK);
		const seen = h.viewerKeys();
		h.states.set(BOOK_ID, { ...h.states.get(BOOK_ID)!, viewerVersion: null });
		expect((await h.run(BOOK)).status).toBe('viewer');
		expect(h.viewerKeys()).toEqual(seen);
		expect(h.deleted).toEqual([]);
	});

	test('a print with no viewer files yet gets them, and its favourites still update', async () => {
		const h = harness();
		await h.run(FIXTURE);
		for (const k of h.viewerKeys()) h.r2.delete(k);
		h.states.set(ID, { ...h.states.get(ID)!, viewerVersion: null });
		expect((await h.run(withRecord((r) => (r.numberOfFavorites = 4242)))).status).toBe('viewer');
		expect(h.viewerKeys().length).toBe(2);
		expect(h.writes).toEqual({ rawPuts: 1, upserts: 1, failures: 0, favorites: 1 });
		expect(h.doc()?.print.favorites).toBe(4242);
	});

	test('a shrunken book deletes its orphaned pages', async () => {
		const h = harness(BOOK_ID);
		await h.run(BOOK);
		const decoded = (await decodeRecord(BOOK)) as { blueprint_book: { blueprints: unknown[] } };
		decoded.blueprint_book.blueprints = decoded.blueprint_book.blueprints.slice(0, 3);
		const blueprintString = await encodeExchangeString(decoded);
		const smaller = withRecord((r) => (r.blueprintString = blueprintString), BOOK);
		expect((await h.run(smaller)).status).toBe('analysed');
		const pages = parseViewerIndex(h.r2.get(viewerIndexKey(BOOK_ID)) ?? null)!.pages.filter((p) => p.kind === 'blueprint');
		expect(pages.length).toBe(3);
		expect(h.viewerKeys()).toEqual([viewerIndexKey(BOOK_ID), ...pages.map((p) => pageStringKey(BOOK_ID, p.path))].sort());
		expect(h.viewer.deletes).toBe(6);
	});

	test('a print that stops decoding loses its viewer files', async () => {
		const h = harness(BOOK_ID);
		await h.run(BOOK);
		expect(h.viewerKeys().length).toBe(10);
		expect((await h.run(withRecord((r) => (r.blueprintString = '0eNotAValidZlibStream'), BOOK))).status).toBe('failed');
		expect(h.viewerKeys()).toEqual([]);
		expect(h.doc()).toBe(null);
		expect(h.states.get(BOOK_ID)?.viewerVersion).toBe(null);
	});
});
