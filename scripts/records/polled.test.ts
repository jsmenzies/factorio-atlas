import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { d1FromSqlite } from '#lib/server/pipeline/d1-sqlite.js';
import { toPipelineText, type SourceRecord } from '#lib/server/pipeline/source-record.js';
import { polledStoreAdapter } from './polled';

const ROOT = join(import.meta.dirname, '..', '..');

const codex = (siteId: string): SourceRecord => ({
	site: 'codex',
	siteId,
	url: `https://factoriocodex.com/blueprints/${siteId}`,
	title: `Codex ${siteId}`,
	description: null,
	author: { site: 'codex', id: '7', name: 'Someone' },
	blueprintString: '0eTEST',
	image: null,
	uploadedAt: 1,
	updatedAt: 9,
	favorites: null,
	tags: [],
	sourceHints: []
});

describe('polled sites in the record store', () => {
	const setup = () => {
		const sqlite = new Database(':memory:');
		for (const f of readdirSync(join(ROOT, 'migrations'))
			.filter((f) => f.endsWith('.sql'))
			.sort())
			sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
		const print = (id: string) =>
			sqlite
				.query(
					`INSERT INTO prints (id, source, source_url, title, raw_key, raw_sha256, ingested_at, analyzer_version, root_kind,
						blueprint_count, entity_count, requires_space_age, uses_circuits, uses_trains)
					VALUES (?, 'codex', 'u', 't', 'k', 's', 1, 1, 'blueprint', 1, 1, 0, 0, 0)`
				)
				.run(id);
		const source = (siteId: string, printId: string, updated: number, gone: number | null = null) =>
			sqlite
				.query(
					`INSERT INTO print_sources (site, site_id, print_id, url, uploaded_at, updated_at, first_seen, gone_at)
					VALUES ('codex', ?, ?, 'u', 1, ?, 1, ?)`
				)
				.run(siteId, printId, updated, gone);
		const objects = new Map<string, string>();
		const raw = { get: async (k: string) => (objects.has(k) ? { text: async () => objects.get(k)! } : null) } as unknown as R2Bucket;
		return { sqlite, print, source, objects, adapter: polledStoreAdapter({ DB: d1FromSqlite(sqlite), RAW: raw }, 'codex') };
	};

	test('lists only the live prints that are their own print: not joined, gone or taken down', async () => {
		const h = setup();
		h.print('codex-1');
		h.source('1', 'codex-1', 11);
		// Joined a factorioprints print: drawn under that id, never its own.
		h.print('-AAAAAAAAAAAAAAAAAAA');
		h.source('2', '-AAAAAAAAAAAAAAAAAAA', 12);
		h.print('codex-3');
		h.source('3', 'codex-3', 13, 50);
		h.print('codex-4');
		h.source('4', 'codex-4', 14);
		h.sqlite.run(`INSERT INTO print_tombstones (print_id, kind, at) VALUES ('codex-4', 'gone', 1)`);
		expect(await h.adapter.list()).toEqual([{ siteId: '1', rev: '11' }]);
	});

	test('reads the record the ingest archived in RAW', async () => {
		const h = setup();
		h.objects.set('codex/1.json', toPipelineText(codex('1')));
		expect(await h.adapter.fetch('1')).toMatchObject({ site: 'codex', siteId: '1', title: 'Codex 1', blueprintString: '0eTEST' });
		expect(await h.adapter.fetch('2')).toBeNull();
	});
});
