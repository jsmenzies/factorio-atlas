import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { d1FromSqlite } from '#lib/server/pipeline/d1-sqlite.js';
import { thumbFile, THUMBS_INDEX, type ThumbsIndex } from '#lib/viewer/thumbs.js';
import { removedGuard } from './removed-guard.js';
import type { RenderStore } from './store.js';
import { createThumbUploader, type ThumbUploadDb } from './thumbs-upload.js';

const ROOT = join(import.meta.dirname, '..', '..');

const stageDb = () => {
	const sqlite = new Database(':memory:');
	for (const f of readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.sort())
		sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
	const queries: string[] = [];
	const d1 = d1FromSqlite(sqlite);
	const db = {
		...d1,
		prepare: (sql: string) => {
			queries.push(sql);
			return d1.prepare(sql);
		}
	} as D1Database;
	return { sqlite, db, queries };
};

describe('removedGuard', () => {
	test("tombstones of either kind and 'print' blocks; one read per run, then one lookup per print not known", async () => {
		const h = stageDb();
		h.sqlite.run(`INSERT INTO print_tombstones (print_id, kind, at) VALUES ('up-AaAaA11111', 'gone', 1), ('-Taken', 'takedown', 1)`);
		h.sqlite.run(
			`INSERT INTO removal_blocks (kind, value, print_id, report_id, created_at) VALUES ('print', '-Blocked', '-Blocked', NULL, 1), ('sha256', 'abc', '-Other', NULL, 1)`
		);
		const lines: string[] = [];
		const g = await removedGuard(h.db, (l) => lines.push(l));
		expect(h.queries.length).toBe(1);
		expect(await g.removed('up-AaAaA11111')).toBe(true);
		expect(await g.removed('-Taken')).toBe(true);
		expect(await g.removed('-Blocked')).toBe(true);
		expect(h.queries.length).toBe(1);
		expect(await g.removed('-Other')).toBe(false);
		expect(await g.removed('up-BbBbB22222')).toBe(false);
		expect(h.queries.length).toBe(3);

		// Deleted mid-run: the re-check before its upload finds it.
		h.sqlite.run(`INSERT INTO print_tombstones (print_id, kind, at) VALUES ('up-BbBbB22222', 'gone', 2)`);
		expect(await g.removed('up-BbBbB22222')).toBe(true);
		expect(await g.removed('up-BbBbB22222')).toBe(true);
		expect([...g.skipped].sort()).toEqual(['-Blocked', '-Taken', 'up-AaAaA11111', 'up-BbBbB22222']);
		expect(lines.length).toBe(4);
	});
});

describe('thumbnail uploads', () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'guard-thumbs-'));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("a deleted print's thumbnails never go up", async () => {
		const id = 'up-AaAaA11111';
		const index: ThumbsIndex = { v: 1, pages: { '': { stamp: 'aaaaaaaaaa', w: 10, h: 10, sizes: [320] } } };
		await mkdir(join(dir, id), { recursive: true });
		await writeFile(join(dir, id, thumbFile('', 'aaaaaaaaaa', 320)), 'avif');
		await writeFile(join(dir, id, THUMBS_INDEX), JSON.stringify(index));
		const puts: string[] = [];
		const store = {
			label: 'fake',
			put: async (key: string) => void puts.push(key),
			delete: async () => undefined,
			list: async () => []
		} as unknown as RenderStore;
		const saved: string[] = [];
		const db: ThumbUploadDb = {
			uploaded: async () => new Map(),
			saveUploaded: async (_t, printId) => void saved.push(printId),
			scheduleDeletes: async () => undefined,
			cancelDeletes: async () => undefined,
			dueThumbDeletes: async () => []
		};
		let deleted = true;
		const up = await createThumbUploader({ store, db, target: 'local', dir, graceMs: 0, log: () => {}, removed: async () => deleted });
		expect(await up.uploadPrint(id)).toBe(true);
		expect(puts).toEqual([]);
		expect(saved).toEqual([]);
		deleted = false;
		expect(await up.uploadPrint(id)).toBe(true);
		expect(puts).toEqual([`${id}/${thumbFile('', 'aaaaaaaaaa', 320)}`, `${id}/${THUMBS_INDEX}`]);
	});
});
