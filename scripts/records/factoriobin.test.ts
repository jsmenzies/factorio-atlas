import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRecord } from '#lib/server/pipeline/add-record.js';
import { d1FromSqlite } from '#lib/server/pipeline/d1-sqlite.js';
import { fixtureRecord } from '#lib/server/fixtures.js';
import type { SourceRecord } from '#lib/server/pipeline/source-record.js';
import { addArgs } from '../add/dev-plugin.js';
import { storeSource } from '../render/source.js';
import { factoriobinStoreAdapter } from './factoriobin';
import { pullOne, pullSite } from './pull';
import { readIndex } from './store';

const ROOT = join(import.meta.dirname, '..', '..');
/** A small 2.0.72 blueprint: one wooden chest (as records.test.ts). */
const STRING =
	'0eJxNjEEKwjAUBe/y1lFabcT8rccoIo1+MJD8lCZVS8jdxerC1TCzmALrZx4nJxlU4DIH0F9T8INlD8LpzunjD56SiwLSh53pjNHHdm9M0ymwZJcdJ1BfvrJcZA6WJ1CrIENgEJ4x3lg2199ujMnl9VfwAjVbrbCsrPVc6xuLpTPq';

const post = (siteId: string, over: Partial<SourceRecord> = {}): SourceRecord => ({
	site: 'factoriobin',
	siteId,
	url: `https://factoriobin.com/post/${siteId}`,
	title: `Post ${siteId}`,
	description: null,
	author: null,
	blueprintString: STRING,
	image: null,
	uploadedAt: 1_000,
	updatedAt: null,
	favorites: null,
	tags: [],
	sourceHints: [],
	...over
});

const stage = () => {
	const sqlite = new Database(':memory:');
	for (const f of readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.sort())
		sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
	const objects = new Map<string, string>();
	const RAW = {
		get: async (k: string) => (objects.has(k) ? { text: async () => objects.get(k)! } : null),
		head: async (k: string) => (objects.has(k) ? {} : null),
		put: async (k: string, v: string) => void objects.set(k, v),
		delete: async () => undefined
	} as unknown as R2Bucket;
	return { sqlite, env: { DB: d1FromSqlite(sqlite), RAW } };
};

describe('factoriobin in the record store', () => {
	test('a print of its own goes into the store at once, the same text a pull writes, and renders read it', async () => {
		const s = stage();
		expect(await addRecord(s.env, post('abcdef12'))).toMatchObject({ status: 'new', printId: 'fbin-abcdef12' });
		const dir = await mkdtemp(join(tmpdir(), 'fbin-store-'));
		try {
			const adapter = factoriobinStoreAdapter(s.env);
			expect(await pullOne(dir, adapter, 'abcdef12')).toBe('new');
			expect(await pullOne(dir, adapter, 'abcdef12')).toBe('same');
			expect(Object.keys((await readIndex(dir, 'factoriobin')).records)).toEqual(['abcdef12']);
			// The update's pull finds nothing to do.
			expect(await pullSite(dir, adapter)).toMatchObject({ listed: 1, added: 0, changed: 0, removed: 0, unchanged: 1 });
			const source = storeSource(dir);
			expect(await source.ids()).toEqual(['fbin-abcdef12']);
			expect(await source.read('fbin-abcdef12')).toEqual({ title: 'Post abcdef12', blueprintString: STRING });
			// Gone from the stage: gone from the store.
			s.sqlite.run(`UPDATE print_sources SET gone_at = 5 WHERE site_id = 'abcdef12'`);
			expect(await pullOne(dir, adapter, 'abcdef12')).toBe('gone');
			expect(await source.ids()).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('a post that joined another print is not listed: no print of its own to render', async () => {
		const s = stage();
		// Big enough to join (a one-chest print would only be suggested: JOIN_MIN_SIZE).
		const belts = (JSON.parse(await fixtureRecord('-KYpTULTDIvDOsJfgjeS')) as { blueprintString: string }).blueprintString;
		await addRecord(s.env, post('first123', { blueprintString: belts }));
		expect(await addRecord(s.env, post('later123', { blueprintString: belts, uploadedAt: 2_000 }))).toMatchObject({
			status: 'joins',
			printId: 'fbin-first123'
		});
		expect((await factoriobinStoreAdapter(s.env).list()).map((l) => l.siteId)).toEqual(['first123']);
	});
});

describe('the dev plugin', () => {
	test('runs the command with the post rebuilt from its id, and refuses anything else', () => {
		expect(addArgs({ link: 'factoriobin.com/post/9kis2r/3?x=$(rm)', stage: 'local', plan: true })).toEqual([
			'scripts/add.ts',
			'https://factoriobin.com/post/9kis2r/3',
			'--stage',
			'local',
			'--plan',
			'--yes',
			'--json'
		]);
		expect(addArgs({ link: 'LYMz5ZJT' })).toContain('prod');
		expect(typeof addArgs({ link: 'https://evil.example/post/x' })).toBe('string');
		expect(typeof addArgs({ link: 'LYMz5ZJT', stage: 'dev' })).toBe('string');
		expect(typeof addArgs({ link: 'LYMz5ZJT', extra: 1 })).toBe('string');
	});
});
