import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskPages, mergePages, uploadedPages } from './flags.js';
import type { UploadJob, UploadRow } from './upload.js';

const job = (print_id: string, path: string, status: UploadJob['status'], stamp: string | null = 's1'): UploadJob => ({
	print_id,
	path,
	status,
	stamp,
	finished_at: 1
});
const up = (print_id: string, path: string, stamp: string | null = 's1'): UploadRow => ({
	target: 'prod',
	print_id,
	path,
	stamp,
	rendered_at: null,
	stale: 0,
	files: 1,
	bytes: 1,
	uploaded_at: 2,
	error: null,
	failed_at: null
});

describe('uploadedPages', () => {
	test('counts the pages the remote index lists', () => {
		const pages = uploadedPages(
			[job('a', '1', 'done'), job('a', '2', 'pending'), job('a', '3', 'done'), job('b', '', 'failed'), job('c', '', 'done')],
			// a: 1 up, 2 up and being re-rendered (stays listed), 3 not up yet; b: up but failed since (dropped next sync);
			// c: only an error row (no stamp); d: rows without jobs.
			[up('a', '1'), up('a', '2'), up('b', ''), up('c', '', null), up('d', '')]
		);
		expect([...pages]).toEqual([['a', 2]]);
	});
});

describe('mergePages', () => {
	test('a print in either source, with its larger count', () => {
		expect([
			...mergePages(
				new Map([
					['a', 1],
					['b', 3]
				]),
				new Map([
					['b', 2],
					['c', 4],
					['d', 0]
				])
			)
		]).toEqual([
			['a', 1],
			['b', 3],
			['c', 4]
		]);
	});
});

describe('diskPages', () => {
	test('reads v2 index.json files with pages; skips the rest', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'render-flags-'));
		try {
			const index = (id: string, body: unknown) => {
				mkdirSync(join(dir, id), { recursive: true });
				writeFileSync(join(dir, id, 'index.json'), JSON.stringify(body));
			};
			index('a', { v: 2, cover: '1', pages: { '1': { stamp: 'x', overview: '1.x.avif' }, '2': { stamp: 'y', overview: '2.y.avif' } } });
			index('b', { v: 1, pages: { '': {} } });
			index('c', { v: 2, cover: null, pages: {} });
			mkdirSync(join(dir, 'd'));
			writeFileSync(join(dir, 'e.json'), '{}');
			mkdirSync(join(dir, 'f'));
			writeFileSync(join(dir, 'f', 'index.json'), 'not json');
			expect([...(await diskPages(dir))]).toEqual([['a', 2]]);
			expect((await diskPages(join(dir, 'missing'))).size).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
