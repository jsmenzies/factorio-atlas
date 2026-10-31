import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { parseArgs, UsageError } from './args.js';
import type { StateEntry } from './state.js';
import { planUploadImages, uploadEntry, type ApprovedImage } from './uploads.js';

// A 3 × 2 PNG header (IHDR) is all the entry reads.
const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0
]);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const approved = (id: string, bytes = PNG): ApprovedImage => ({ id, ext: 'png', sha256: sha(bytes), prints: ['up-AbCdEfGhIj'] });
const entry = (id: string, status: StateEntry['status'], file?: string): StateEntry => ({
	id,
	status,
	prints: [],
	labelled: null,
	attempts: 1,
	at: '',
	...(file ? { file } : {})
});

describe('--from-uploads', () => {
	test('plans the approved images not copied yet; removed ones never come back', () => {
		const state = new Map<string, StateEntry>([
			['upload.aaaaaaaaaaaaaaaa', entry('upload.aaaaaaaaaaaaaaaa', 'fetched', 'originals/up/upload.aaaaaaaaaaaaaaaa.png')],
			['upload.bbbbbbbbbbbbbbbb', entry('upload.bbbbbbbbbbbbbbbb', 'fetched', 'originals/up/gone.png')],
			['upload.cccccccccccccccc', entry('upload.cccccccccccccccc', 'removed')],
			['upload.dddddddddddddddd', entry('upload.dddddddddddddddd', 'failed')]
		]);
		const list = ['a', 'b', 'c', 'd', 'e'].map((c) => approved(c.repeat(16)));
		const plan = planUploadImages(list, state, (e) => e.file === 'originals/up/upload.aaaaaaaaaaaaaaaa.png');
		expect(plan.done).toBe(1);
		expect(plan.removed).toBe(1);
		expect(plan.todo.map((a) => a.id)).toEqual(['b'.repeat(16), 'd'.repeat(16), 'e'.repeat(16)]);
	});

	test('an original becomes a fetched entry under `upload.<id>`, as Imgur originals are', () => {
		const e = uploadEntry(approved('0123456789abcdef'), PNG, 'now');
		expect(e).toMatchObject({
			id: 'upload.0123456789abcdef',
			status: 'fetched',
			file: 'originals/up/upload.0123456789abcdef.png',
			type: 'png',
			labelled: 'image/png',
			bytes: PNG.length,
			width: 3,
			height: 2,
			prints: ['up-AbCdEfGhIj']
		});
	});

	test('bytes that aren’t what the upload recorded, or no image at all, fail', () => {
		const wrong = uploadEntry({ ...approved('0123456789abcdef'), sha256: '0'.repeat(64) }, PNG, 'now');
		expect(wrong.status).toBe('failed');
		expect(wrong.reason).toContain('SHA-256');
		const text = new TextEncoder().encode('<svg/>');
		const svg = uploadEntry(approved('0123456789abcdef', text), text, 'now');
		expect(svg.status).toBe('failed');
		expect(svg.reason).toContain('not a');
	});

	test('the option takes a stage, and upload image ids', () => {
		const defaults = { clone: '/c', disk: '/d', root: '/' };
		expect(parseArgs(['--from-uploads', 'prod', '--json'], defaults)).toMatchObject({ mode: 'uploads', target: 'prod', json: true });
		expect(parseArgs(['--from-uploads', 'local', '--ids', 'upload.0123456789abcdef'], defaults)).toMatchObject({
			ids: ['upload.0123456789abcdef']
		});
		expect(() => parseArgs(['--from-uploads', 'staging'], defaults)).toThrow(UsageError);
		expect(() => parseArgs(['--from-uploads', 'local', '--upload', 'local'], defaults)).toThrow(UsageError);
		expect(() => parseArgs(['--ids', 'upload.xyz'], defaults)).toThrow(UsageError);
	});
});
