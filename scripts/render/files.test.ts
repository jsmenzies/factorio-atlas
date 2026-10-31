import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexDiffers, indexWriter, writeIndex } from './files';

type Done = { path: string; stamp: string; overview: string };
const page = (path: string, stamp = '0123456789'): Done => ({ path, stamp, overview: `${path || 'root'}.${stamp}.avif` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withDir(fn: (dir: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), 'render-files-'));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
const listed = async (dir: string, id: string) =>
	Object.keys((JSON.parse(await readFile(join(dir, id, 'index.json'), 'utf8')) as { pages: object }).pages).sort();

describe('index.json writes of one print', () => {
	// Pages 1, 2 and 3 finish 10 ms apart; each one's write is slower than the next one's, as when an
	// fsync stalls. The done rows grow as each page finishes (render_jobs, read back per write).
	const finishes = [
		{ path: '1', writeMs: 60 },
		{ path: '2', writeMs: 30 },
		{ path: '3', writeMs: 5 }
	];

	test('written straight from each page’s own list, an older list can land last (the bug)', async () => {
		await withDir(async (dir) => {
			const done: Done[] = [];
			// Each page's write lands only after the next page's has: the newest list is overwritten.
			const landed = finishes.map(() => Promise.withResolvers<void>());
			await Promise.all(
				finishes.map(async (f, i) => {
					await sleep(i * 10);
					done.push(page(f.path));
					const mine = [...done];
					if (i + 1 < finishes.length) await landed[i + 1].promise;
					await writeIndex(dir, 'p', mine);
					landed[i].resolve();
				})
			);
			expect(await listed(dir, 'p')).toEqual(['1']);
		});
	});

	test('through indexWriter, the last write lists every done page, whatever order the writes take', async () => {
		await withDir(async (dir) => {
			const done: Done[] = [];
			const delays = new Map(finishes.map((f) => [f.path, f.writeMs]));
			let writes = 0;
			const writer = indexWriter(
				async () => [...done],
				async (id, list) => {
					// Slow by the newest page in the list, so a stale list would be the slowest.
					await sleep(delays.get(list.at(-1)!.path) ?? 0);
					writes++;
					await writeIndex(dir, id, list);
				}
			);
			await Promise.all(
				finishes.map(async (f, i) => {
					await sleep(i * 10);
					done.push(page(f.path));
					await writer.update('p');
				})
			);
			expect(await listed(dir, 'p')).toEqual(['1', '2', '3']);
			expect(writes).toBe(3);
			expect(writer.busy).toBe(0);
		});
	});

	test('a failed write rejects only its own update; the next one still writes', async () => {
		await withDir(async (dir) => {
			let fail = true;
			const writer = indexWriter(
				async () => [page('')],
				async (id, list) => {
					if (fail) {
						fail = false;
						throw new Error('disk full');
					}
					await writeIndex(dir, id, list);
				}
			);
			const first = writer.update('p');
			const second = writer.update('p');
			await expect(first).rejects.toThrow('disk full');
			await second;
			expect(await listed(dir, 'p')).toEqual(['']);
		});
	});
});

describe('indexDiffers', () => {
	test('same pages and stamps: no; a page missing, an extra page, another stamp or no file: yes', async () => {
		await withDir(async (dir) => {
			await writeIndex(dir, 'p', [page('1'), page('2')]);
			expect(await indexDiffers(dir, 'p', [page('2'), page('1')])).toBe(false);
			expect(await indexDiffers(dir, 'p', [page('1'), page('2'), page('3')])).toBe(true);
			expect(await indexDiffers(dir, 'p', [page('1')])).toBe(true);
			expect(await indexDiffers(dir, 'p', [page('1'), page('2', 'abcdefabcd')])).toBe(true);
			expect(await indexDiffers(dir, 'q', [page('1')])).toBe(true);
			expect(await indexDiffers(dir, 'q', [])).toBe(false);
			// An index.json whose pages have no done row any more (a plan-only run left them): rewritten.
			expect(await indexDiffers(dir, 'p', [])).toBe(true);
		});
	});
});
