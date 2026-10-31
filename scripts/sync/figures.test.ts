import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { d1FromSqlite } from '#lib/server/pipeline/d1-sqlite.js';
import { ANALYZER_VERSION } from '#lib/server/pipeline/analyze.js';
import { assembleSources, figureStatements, parseFigures, refusedPosts } from './figures';

const ROOT = join(import.meta.dirname, '..', '..');

const setup = () => {
	const sqlite = new Database(':memory:');
	for (const f of readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.sort())
		sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
	const print = (
		id: string,
		source: string,
		o: { author?: string | null; image?: string | null; folded?: string; version?: number } = {}
	) => {
		sqlite
			.query(
				`INSERT INTO prints (id, source, source_url, title, raw_key, raw_sha256, ingested_at, analyzer_version, root_kind,
					blueprint_count, entity_count, requires_space_age, uses_circuits, uses_trains, author_name, image_id, duplicate_of)
				VALUES (?, ?, 'u', 't', 'k', 's', 1, 1, 'blueprint', 1, 1, 0, 0, 0, ?, ?, ?)`
			)
			.run(id, source, o.author === undefined ? 'Someone' : o.author, o.image ?? null, o.folded ?? null);
		sqlite
			.query(`INSERT INTO ingest_state (print_id, content_sha256, status, analyzer_version, checked_at) VALUES (?, 's', 'ok', ?, 1)`)
			.run(id, o.version ?? ANALYZER_VERSION);
	};
	const post = (site: string, siteId: string, printId: string, gone: number | null = null) =>
		sqlite
			.query(`INSERT INTO print_sources (site, site_id, print_id, url, uploaded_at, first_seen, gone_at) VALUES (?, ?, ?, 'u', 1, 1, ?)`)
			.run(site, siteId, printId, gone);
	const shot = (id: string, state = 'copied') =>
		sqlite.query(`INSERT INTO screenshots (image_id, state, updated_at) VALUES (?, ?, 1)`).run(id, state);
	return { sqlite, db: d1FromSqlite(sqlite), print, post, shot };
};

const FP = (n: number) => `-${String(n).padStart(19, 'A')}`;

describe('the figures step: per source', () => {
	test('prints by credited site, posts and duplicates, unreadable, credit and unused screenshots', async () => {
		const h = setup();
		// factorioprints: a named print with its screenshot, a folded copy, one on an older analyser, one whose image died.
		h.print(FP(1), 'factorioprints', { image: 'aaaaaaa' });
		h.post('factorioprints', FP(1), FP(1));
		h.print(FP(2), 'factorioprints', { image: 'aaaaaaa', folded: FP(1) });
		h.post('factorioprints', FP(2), FP(2));
		h.print(FP(3), 'factorioprints', { image: 'ddddddd', version: ANALYZER_VERSION - 1 });
		h.post('factorioprints', FP(3), FP(3));
		h.shot('aaaaaaa');
		h.shot('ddddddd', 'dead');
		h.shot('zzzzzzz'); // shown by no print
		h.sqlite.run(`INSERT INTO ingest_state (print_id, content_sha256, status, checked_at) VALUES ('${FP(9)}', 's', 'failed', 1)`);
		// A factorioprints id credited to codex (posted there first); codex posted it twice; another codex print with no name.
		h.print(FP(4), 'codex', { author: null, image: 'codex.1' });
		h.post('factorioprints', FP(4), FP(4));
		h.post('codex', '10', FP(4));
		h.post('codex', '11', FP(4));
		h.print('codex-12', 'codex', { author: '' });
		h.post('codex', '12', 'codex-12');
		h.post('codex', '13', 'codex-12', 5); // gone: not counted
		h.shot('codex.1');
		// fprints: one print, and one post that joined the codex print.
		h.print('fprints-a', 'fprints', { author: null });
		h.post('fprints', 'a', 'fprints-a');
		h.post('fprints', 'b', 'codex-12');
		// An empty author name is no name, in both counts.
		h.print(FP(5), 'factorioprints', { author: '' });
		h.post('factorioprints', FP(5), FP(5));
		// A codex post that passed the gate but failed its ingest: a failed ingest_state row, no source row. Counted once.
		h.sqlite.run(`INSERT INTO ingest_state (print_id, content_sha256, status, checked_at) VALUES ('codex-15', 's', 'failed', 1)`);

		const results = await h.db.batch(figureStatements(h.db));
		// The ledgers: codex gave the stage 10–13, 14 (refused, no row), 15 (its ingest failed), 16 (refused, its source
		// gone since) and 17 (refused, gone from the site since); fprints a, b.
		const rev = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, 'r']));
		const { figures: f, credit } = parseFigures(
			'local',
			results,
			{
				codex: { ledger: { ...rev(['10', '11', '12', '13', '14', '15', '17']), 16: 'gone' }, gone: ['17'] },
				fprints: { ledger: rev(['a', 'b']), gone: [] }
			},
			7
		);
		expect(f.prints).toBe(7);
		expect(f.unnamed).toBe(1);
		expect(f.analyzerVersion).toBe(ANALYZER_VERSION);
		expect(f.sources).toEqual({
			factorioprints: { prints: 4, folded: 1, analysed: 3, named: 3, shot: 2, posts: 5, dupOther: 1, dupSame: 0, unreadable: 1 },
			codex: { prints: 2, folded: 0, analysed: 2, named: 0, shot: 1, posts: 3, dupOther: 0, dupSame: 1, unreadable: 2 },
			fprints: { prints: 1, folded: 0, analysed: 1, named: 0, shot: 0, posts: 2, dupOther: 1, dupSame: 0, unreadable: 0 }
		});
		expect(credit).toEqual({ [FP(4)]: 'codex' });
		expect(JSON.stringify(f)).not.toContain(FP(4));
		expect(f.unusedShots).toBe(1);
		expect(f.attention).toEqual({ reports: 0, screenshots: 0, deleting: 0, processing: 0 });
	});

	test('a polled site with no ledger on this machine: unreadable not known', async () => {
		const h = setup();
		h.print('codex-1', 'codex');
		h.post('codex', '1', 'codex-1');
		const { figures } = parseFigures('local', await h.db.batch(figureStatements(h.db)), { codex: { ledger: null, gone: [] } });
		expect(figures.sources?.codex.unreadable).toBeNull();
	});

	test('sites nothing records refusals for have no unreadable count', () => {
		const s = assembleSources(
			[{ site: 'factoriobin', prints: 2, folded: 0, analysed: 2, named: 0, shot: 0 }],
			[{ site: 'factoriobin', posts: 3, other: 1, own: 2, own_prints: 2 }],
			{},
			{}
		);
		expect(s.factoriobin).toMatchObject({ posts: 3, dupOther: 1, dupSame: 0, unreadable: null });
		expect(refusedPosts('codex', { 1: 'r', 2: 'r', 3: 'r', 4: 'gone' }, new Set(['2']))).toBe(2);
		expect(refusedPosts('codex', { 1: 'r', 3: 'r' }, new Set(), new Set(['1']), new Set(['codex-3']))).toBe(0);
	});
});
