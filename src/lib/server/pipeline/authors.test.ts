import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanName, fetchDisplayName, planNameFixes, recordNames, unknownAuthors, type AuthorState } from './authors';
import { authorToken, slug } from './repository';

const ROOT = join(import.meta.dirname, '../../../..');

const state = (prints: [string, string, string | null][], authors: [string, string | null][] = []): AuthorState => ({
	prints: prints.map(([id, author_id, author_name]) => ({ id, author_id, author_name })),
	authors: new Map(authors),
	searchRows: new Map(prints.map(([id], i) => [id, i + 1]))
});

describe('planning', () => {
	const s = state(
		[
			['p1', 'A', null],
			['p2', 'A', 'Alice'],
			['p3', 'B', null],
			['p4', 'B', null],
			['p5', 'C', null],
			['p6', 'D', null]
		],
		[['D', null]]
	);

	test("a record's name names its author; the rest are asked, most prints first; an answered id never again", () => {
		expect(recordNames(s)).toEqual([['A', 'Alice']]);
		expect(unknownAuthors(s)).toEqual(['B', 'C']);
	});

	test('only prints without a name get one, from their author', () => {
		const named = { ...s, authors: new Map([...s.authors, ['A', 'Alice'], ['B', 'Bob'], ['C', null]] as [string, string | null][]) };
		expect(planNameFixes(named)).toEqual([
			{ id: 'p1', name: 'Alice', rowid: 1 },
			{ id: 'p3', name: 'Bob', rowid: 3 },
			{ id: 'p4', name: 'Bob', rowid: 4 }
		]);
	});

	test('names are trimmed; blanks and non-strings are none', () => {
		expect([cleanName('  Nilaus '), cleanName(''), cleanName('   '), cleanName(null), cleanName(42)]).toEqual([
			'Nilaus',
			null,
			null,
			null,
			null
		]);
	});
});

describe('fetchDisplayName', () => {
	const answering = (status: number, body: unknown) => {
		const urls: string[] = [];
		const fetcher = (async (url: string) => {
			urls.push(url);
			return new Response(JSON.stringify(body), { status });
		}) as unknown as typeof fetch;
		return { urls, fetcher };
	};

	test('asks for the one public field and returns the name, or null', async () => {
		const named = answering(200, 'Nilaus');
		expect(await fetchDisplayName('abc123', 'https://fb.example', named.fetcher)).toBe('Nilaus');
		expect(named.urls).toEqual(['https://fb.example/users/abc123/displayName.json']);
		expect(await fetchDisplayName('abc123', 'https://fb.example', answering(200, null).fetcher)).toBeNull();
	});

	test('anything but a 200 throws, so the run stops rather than saving "no name"', async () => {
		expect(fetchDisplayName('abc123', 'https://fb.example', answering(401, { error: 'Permission denied' }).fetcher)).rejects.toThrow('401');
	});
});

describe('migration 0017', () => {
	test('rebuilds the search index with an author column and by_ token, and seeds authors from records', () => {
		const sqlite = new Database(':memory:');
		const files = readdirSync(join(ROOT, 'migrations'))
			.filter((f) => f.endsWith('.sql'))
			.sort();
		for (const f of files.filter((f) => f < '0017')) sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
		const print = sqlite.query(
			`INSERT INTO prints (id, source, source_url, title, author_id, author_name, favorites, raw_key, raw_sha256, ingested_at, analyzer_version,
				root_kind, blueprint_count, entity_count, requires_space_age, uses_circuits, uses_trains)
			VALUES (?, 'factorioprints', '', ?, ?, ?, 0, '', '', 0, 0, 'blueprint', 1, 0, 0, 0, 0)`
		);
		print.run('p1', 'Red science', 'AbCdEfGhIjKlMnOpQrStUvWxYz12', 'Alice');
		print.run('p2', 'Belts', 'AbCdEfGhIjKlMnOpQrStUvWxYz12', null);
		print.run('p3', 'Trains', 'ZyXwVuTsRqPoNmLkJiHgFeDcBa98', null);
		const fts = sqlite.query(
			`INSERT INTO print_search (print_id, title, description, labels, entities, recipes, nicknames, facets) VALUES (?, ?, '', '', '', '', '', ?)`
		);
		fts.run('p1', 'Red science', 'render_yes sa_no');
		fts.run('p2', 'Belts', 'sa_no');
		fts.run('p3', 'Trains', 'uses_trains');

		sqlite.run(
			readFileSync(
				join(
					ROOT,
					'migrations',
					files.find((f) => f.startsWith('0017'))!
				),
				'utf8'
			)
		);
		const rows = sqlite.query('SELECT print_id, title, author, facets FROM print_search ORDER BY print_id').all();
		const a = authorToken('AbCdEfGhIjKlMnOpQrStUvWxYz12');
		expect(a).toBe(`by_${slug('AbCdEfGhIjKlMnOpQrStUvWxYz12')}`);
		expect(rows).toEqual([
			{ print_id: 'p1', title: 'Red science', author: 'Alice', facets: `${a} render_yes sa_no` },
			{ print_id: 'p2', title: 'Belts', author: '', facets: `${a} sa_no` },
			{ print_id: 'p3', title: 'Trains', author: '', facets: `${authorToken('ZyXwVuTsRqPoNmLkJiHgFeDcBa98')} uses_trains` }
		]);
		const match = (q: string) =>
			(sqlite.query('SELECT print_id FROM print_search WHERE print_search MATCH ? ORDER BY print_id').all(q) as { print_id: string }[]).map(
				(r) => r.print_id
			);
		expect(match(`facets : "${a}"`)).toEqual(['p1', 'p2']);
		expect(match('author : "alice"*')).toEqual(['p1']);
		expect(match('facets : "render_yes"')).toEqual(['p1']);
		expect(sqlite.query('SELECT author_id, display_name, source FROM authors').all()).toEqual([
			{ author_id: 'AbCdEfGhIjKlMnOpQrStUvWxYz12', display_name: 'Alice', source: 'record' }
		]);
	});
});
