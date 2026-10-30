import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { manifestKey, shotKeys } from '#lib/screenshots.js';
import type { RenderStore } from '../render/store.js';
import { DELETE_GRACE_MS, dueDeletes, formatLine, readLedger, type Held, type LedgerLine } from './ledger.js';
import { decodes, makeSizes, readMade } from './make.js';
import { originalPath, type StateEntry } from './state.js';
import { graceFor, syncImage, wantedManifest } from './upload.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Every test gets its own folder, removed after it. */
let dir = '';
const inDir = (f: () => Promise<void>) => async () => {
	dir = mkdtempSync(join(tmpdir(), 'shots-test-'));
	try {
		await f();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

/** An in-memory bucket that records the order of calls. */
const memoryStore = () => {
	const objects = new Map<string, { body: Uint8Array; contentType: string; cacheControl: string }>();
	const calls: string[] = [];
	const store: RenderStore = {
		label: 'memory',
		put: async (key, body, contentType, cacheControl) => {
			calls.push(`put ${key}`);
			objects.set(key, { body, contentType, cacheControl });
		},
		delete: async (key) => {
			calls.push(`delete ${key}`);
			objects.delete(key);
		},
		list: async (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix))
	};
	return { store, objects, calls };
};

const png = (w: number, h: number) =>
	sharp({ create: { width: w, height: h, channels: 4, background: { r: 200, g: 120, b: 40, alpha: 0.5 } } })
		.png()
		.toBuffer()
		.then((b) => new Uint8Array(b));

const fetched = async (id: string, bytes: Uint8Array, type: 'png' | 'jpeg' | 'gif' = 'png'): Promise<StateEntry> => {
	const file = originalPath(id, type === 'jpeg' ? 'jpg' : type);
	await mkdir(dirname(join(dir, file)), { recursive: true });
	await writeFile(join(dir, file), bytes);
	return {
		id,
		status: 'fetched',
		prints: ['-AAAAAAAAAAAAAAAAAAA'],
		labelled: 'image/png',
		file,
		type,
		bytes: bytes.length,
		attempts: 1,
		at: '2026-10-24T00:00:00Z'
	};
};

describe('makeSizes', () => {
	test(
		'every size, never enlarged, with made.json last',
		inDir(async () => {
			const e = await fetched('Mk1aaaa', await png(1000, 700));
			const made = await makeSizes(dir, e.id, 'png', await png(1000, 700));
			expect(made).toMatchObject({ id: 'Mk1aaaa', v: 1, ext: 'png', w: 1000, h: 700 });
			expect(Object.keys(made.bytes).sort()).toEqual([
				'Mk1aaaa.v1.c320.avif',
				'Mk1aaaa.v1.c640.avif',
				'Mk1aaaa.v1.c960.avif',
				'Mk1aaaa.v1.l.avif',
				'Mk1aaaa.v1.og.jpg'
			]);
			const meta = await sharp(join(dir, 'sizes/Mk/Mk1aaaa.v1.c960.avif')).metadata();
			// The 1000 × 563 crop, scaled to fit 960 × 540.
			expect([meta.width, meta.height]).toEqual([959, 540]);
			const og = await sharp(join(dir, 'sizes/Mk/Mk1aaaa.v1.og.jpg')).metadata();
			expect([og.format, og.width, og.height, og.hasAlpha]).toEqual(['jpeg', 1000, 700, false]);
			expect(await readMade(dir, 'Mk1aaaa')).toMatchObject({ w: 1000, h: 700 });
			expect(await readMade(dir, 'Nothere')).toBeNull();
		})
	);

	test(
		'an over-cap original gets a scaled-down full size',
		inDir(async () => {
			const big = new Uint8Array(
				await sharp({ create: { width: 4000, height: 2500, channels: 3, background: '#335' } })
					.jpeg()
					.toBuffer()
			);
			const made = await makeSizes(dir, 'Big1aaa', 'jpeg', big);
			expect(Object.keys(made.bytes)).toContain('Big1aaa.v1.full.jpg');
			const m = await sharp(join(dir, 'sizes/Bi/Big1aaa.v1.full.jpg')).metadata();
			expect(m.width! * m.height! <= 3840 * 2160).toBe(true);
		})
	);

	test(
		"a tall 37 MP PNG, the shape of codex's largest image, gets every size and a scaled-down full one",
		inDir(async () => {
			const tall = await png(2949, 12446);
			const made = await makeSizes(dir, 'codex.aaaaaaaaaaaaaaaa', 'png', tall);
			expect(made).toMatchObject({ w: 2949, h: 12446 });
			expect(Object.keys(made.bytes)).toContain('codex.aaaaaaaaaaaaaaaa.v1.full.webp');
			const full = await sharp(join(dir, 'sizes/co/codex.aaaaaaaaaaaaaaaa.v1.full.webp')).metadata();
			expect(full.width! * full.height! <= 3840 * 2160 && full.height! <= 8192).toBe(true);
			const large = await sharp(join(dir, 'sizes/co/codex.aaaaaaaaaaaaaaaa.v1.l.avif')).metadata();
			expect(Math.max(large.width!, large.height!)).toBe(2560);
		})
	);

	test(
		'decodes: a complete file does, a cut-off one does not',
		inDir(async () => {
			const ok = await png(300, 200);
			expect(await decodes(ok)).toBe(true);
			const jpeg = new Uint8Array(
				await sharp({ create: { width: 300, height: 200, channels: 3, background: '#000' } })
					.jpeg()
					.toBuffer()
			);
			expect(await decodes(jpeg.slice(0, Math.floor(jpeg.length / 2)))).toBe(false);
		})
	);
});

describe('syncImage', () => {
	test(
		'files first, the manifest last; a second run puts nothing',
		inDir(async () => {
			const e = await fetched('Up1aaaa', await png(800, 450));
			const made = await makeSizes(dir, e.id, 'png', await png(800, 450));
			const { store, objects, calls } = memoryStore();
			const held = new Map<string, Held>();
			const lines: LedgerLine[] = [];
			const ctx = { dir, store, held, append: (l: LedgerLine) => void lines.push(l), now: () => 1000 };
			const r = await syncImage(ctx, e, made);
			const keys = shotKeys({ id: e.id, v: 1, ext: 'png', w: 800, h: 450 });
			expect(r).toMatchObject({ put: keys.length + 1, deleted: 0, unchanged: false });
			expect(calls.at(-1)).toBe(`put ${manifestKey(e.id)}`);
			expect(new Set(calls.slice(0, -1))).toEqual(new Set(keys.map((k) => `put ${k}`)));
			expect(objects.get('Up1aaaa.png')?.cacheControl).toContain('immutable');
			expect(JSON.parse(new TextDecoder().decode(objects.get(manifestKey(e.id))!.body))).toEqual({
				state: 'copied',
				v: 1,
				ext: 'png',
				w: 800,
				h: 450
			});
			// The ledger, written and read back, says the same.
			expect(readLedger(lines.map(formatLine).join('')).held.get(e.id)?.keys.size).toBe(keys.length);
			calls.length = 0;
			expect(await syncImage(ctx, e, made)).toMatchObject({ put: 0, unchanged: true });
			expect(calls).toEqual([]);
		})
	);

	test(
		'deleted on Imgur: a removed manifest now, the files after the grace period',
		inDir(async () => {
			const e = await fetched('Gone1aa', await png(400, 300));
			const made = await makeSizes(dir, e.id, 'png', await png(400, 300));
			const { store, objects } = memoryStore();
			const held = new Map<string, Held>();
			let t = 0;
			const ctx = { dir, store, held, append: () => {}, now: () => t };
			await syncImage(ctx, e, made);
			const removed: StateEntry = { ...e, status: 'removed', by: 'imgur' };
			t = 10;
			expect(await syncImage(ctx, removed, null)).toMatchObject({ put: 1, deleted: 0 });
			expect(JSON.parse(new TextDecoder().decode(objects.get(manifestKey(e.id))!.body))).toEqual({ state: 'removed' });
			t = 10 + DELETE_GRACE_MS;
			const r = await syncImage(ctx, removed, null);
			expect(r?.deleted).toBeGreaterThan(0);
			expect([...objects.keys()]).toEqual([manifestKey(e.id)]);
		})
	);

	test(
		'removed on request: the files go at once; dead: a manifest alone; failed: nothing',
		inDir(async () => {
			const e = await fetched('Req1aaa', await png(400, 300));
			const made = await makeSizes(dir, e.id, 'png', await png(400, 300));
			const { store, objects } = memoryStore();
			const ctx = { dir, store, held: new Map<string, Held>(), append: () => {}, now: () => 5 };
			await syncImage(ctx, e, made);
			await syncImage(ctx, { ...e, status: 'removed', by: 'request' }, null);
			expect([...objects.keys()]).toEqual([manifestKey(e.id)]);
			expect(wantedManifest({ ...e, status: 'dead' }, null)).toEqual({ state: 'dead' });
			expect(wantedManifest({ ...e, status: 'failed' }, null)).toBeNull();
			expect(wantedManifest(e, null)).toBeNull();
			expect(graceFor({ ...e, status: 'removed', by: 'request' })).toBe(0);
			expect(graceFor({ ...e, status: 'removed', by: 'imgur' })).toBe(DELETE_GRACE_MS);
		})
	);
});

describe('ledger', () => {
	test('readLedger keeps what is in the bucket; dueDeletes waits for the grace period', () => {
		const text = [
			formatLine({ id: 'x', put: ['a', 'b'], manifest: { state: 'copied', v: 1, ext: 'png', w: 1, h: 1 }, graceMs: 100, at: 0 }),
			formatLine({ id: 'x', put: ['c'], manifest: { state: 'copied', v: 2, ext: 'png', w: 1, h: 1 }, graceMs: 100, at: 50 }),
			formatLine({ id: 'x', deleted: ['a'], at: 60 }),
			'not json\n',
			'{"id":"y"}\n'
		].join('');
		const { held, bad } = readLedger(text);
		expect(bad).toBe(2);
		const h = held.get('x')!;
		expect([...h.keys].sort()).toEqual(['b', 'c']);
		expect(dueDeletes(h, ['c'], 100)).toEqual([]);
		expect(dueDeletes(h, ['c'], 150)).toEqual(['b']);
	});
});
