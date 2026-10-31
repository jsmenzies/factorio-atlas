import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { THUMBS_INDEX, thumbFile, type ThumbsIndex } from '#lib/viewer/thumbs.js';
import { StoreError, type RenderStore } from './store.js';
import { createThumbUploader, FILE_CONCURRENCY, type ThumbUploadDb } from './thumbs-upload.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ID = '-Pbook';
const PAGES = 40;
const TIERS = [320, 640, 960];
const STAMP = '0123456789';

const tmp = await mkdtemp(join(tmpdir(), 'thumbs-upload-'));
afterAll(() => rm(tmp, { recursive: true, force: true }));

/** A print with PAGES pages of thumbnails on disk: PAGES × 3 files and its thumbs.json. */
async function printOnDisk(dir: string): Promise<{ index: ThumbsIndex; files: string[] }> {
	const index: ThumbsIndex = { v: 1, pages: {} };
	const files: string[] = [];
	for (let p = 0; p < PAGES; p++) {
		index.pages[String(p)] = { stamp: STAMP, w: 1000, h: 500, sizes: TIERS };
		for (const t of TIERS) files.push(thumbFile(String(p), STAMP, t));
	}
	for (const f of files) {
		await mkdir(dirname(join(dir, ID, f)), { recursive: true });
		await writeFile(join(dir, ID, f), new Uint8Array(100));
	}
	await writeFile(join(dir, ID, THUMBS_INDEX), JSON.stringify(index));
	return { index, files };
}

/** Records what happens, in order: puts (with how many were in flight) and D1 writes. */
function fakes(opts: { failOn?: string; delayMs?: number } = {}) {
	const events: string[] = [];
	let inFlight = 0;
	let peak = 0;
	const store: RenderStore = {
		label: 'fake',
		async put(key) {
			inFlight++;
			peak = Math.max(peak, inFlight);
			try {
				await sleep(opts.delayMs ?? 1);
				if (opts.failOn && key.endsWith(opts.failOn)) throw new StoreError('refused', false);
				events.push(`put ${key.slice(ID.length + 1)}`);
			} finally {
				inFlight--;
			}
		},
		async delete() {},
		async list() {
			return [];
		}
	};
	const db: ThumbUploadDb = {
		uploaded: async () => new Map(),
		saveUploaded: async () => void events.push('saveUploaded'),
		scheduleDeletes: async () => {},
		cancelDeletes: async () => {},
		dueThumbDeletes: async () => []
	};
	return { store, db, events, peak: () => peak };
}

describe('thumbnail upload of one print', () => {
	test('files go up several at a time; thumbs.json after every file, the row after that', async () => {
		const dir = join(tmp, 'a');
		const { files } = await printOnDisk(dir);
		const f = fakes();
		const up = await createThumbUploader({ store: f.store, db: f.db, target: 'local', dir, graceMs: 0, log: () => {} });
		expect(await up.uploadPrint(ID)).toBe(true);
		expect(f.peak()).toBe(FILE_CONCURRENCY);
		const puts = f.events.filter((e) => e.startsWith('put ') && !e.endsWith(THUMBS_INDEX));
		expect(puts.length).toBe(files.length);
		expect(f.events.slice(-2)).toEqual([`put ${THUMBS_INDEX}`, 'saveUploaded']);
		expect(up.stats).toMatchObject({ uploaded: 1, files: files.length, bytes: files.length * 100, failed: 0 });
		expect(up.uploading().size).toBe(0);
	});

	test('a failed file: no new file starts, no thumbs.json, no row; the print is left for next time', async () => {
		const dir = join(tmp, 'b');
		const { files } = await printOnDisk(dir);
		const f = fakes({ failOn: files[20] });
		const lines: string[] = [];
		const up = await createThumbUploader({ store: f.store, db: f.db, target: 'local', dir, graceMs: 0, log: (l) => lines.push(l) });
		expect(await up.uploadPrint(ID)).toBe(false);
		expect(f.events).not.toContain(`put ${THUMBS_INDEX}`);
		expect(f.events).not.toContain('saveUploaded');
		// Only files started before the failure was seen went up (two rounds of FILE_CONCURRENCY at most), not the rest.
		expect(f.events.length).toBeLessThan(20 + 2 * FILE_CONCURRENCY + 1);
		expect(up.stats.failed).toBe(1);
		expect(lines.some((l) => l.includes('refused'))).toBe(true);
		expect(up.uploading().size).toBe(0);
	});

	test('a stop: files in flight finish, nothing more goes up', async () => {
		const dir = join(tmp, 'c');
		await printOnDisk(dir);
		const f = fakes();
		let stop = false;
		const up = await createThumbUploader({
			store: f.store,
			db: f.db,
			target: 'local',
			dir,
			graceMs: 0,
			log: () => {},
			stopped: () => stop
		});
		const done = up.uploadPrint(ID);
		await sleep(5);
		stop = true;
		expect(await done).toBe(false);
		expect(f.events).not.toContain(`put ${THUMBS_INDEX}`);
		expect(f.events).not.toContain('saveUploaded');
	});

	test('progress: files put of those to put while it runs, and a log line now and then', async () => {
		const dir = join(tmp, 'd');
		const { files } = await printOnDisk(dir);
		const f = fakes({ delayMs: 2 });
		const lines: string[] = [];
		const up = await createThumbUploader({
			store: f.store,
			db: f.db,
			target: 'local',
			dir,
			graceMs: 0,
			fileConcurrency: 4,
			progressLogMs: 0,
			log: (l) => lines.push(l)
		});
		const done = up.uploadPrint(ID);
		await sleep(20);
		const p = up.uploading().get(ID);
		expect(p?.of).toBe(files.length);
		expect(p!.done).toBeGreaterThan(0);
		expect(p!.done).toBeLessThan(files.length);
		expect(await done).toBe(true);
		expect(up.uploading().size).toBe(0);
		expect(new RegExp(`^thumbnails: uploading ${ID} \\d+ of ${files.length} files$`).test(lines[0])).toBe(true);
		// Never "N of N": the last file ends the upload, not a progress line.
		expect(lines.every((l) => !l.endsWith(`${files.length} of ${files.length} files`))).toBe(true);
	});
});
