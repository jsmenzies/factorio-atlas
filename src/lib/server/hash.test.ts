import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { sha256Hex } from './hash';

// The copies sha256Hex replaced, kept here to prove it gives the same hex for what each one hashed.
const oldText = async (text: string) => {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};
const oldUploads = async (bytes: Uint8Array | string) =>
	[
		...new Uint8Array(
			await crypto.subtle.digest('SHA-256', (typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes) as BufferSource)
		)
	]
		.map((x) => x.toString(16).padStart(2, '0'))
		.join('');
const oldShort = async (text: string) => {
	const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
	return Array.from(hash.slice(0, 6), (b) => b.toString(16).padStart(2, '0')).join('');
};

const TEXTS = ['', 'abc', '{"blueprint":{"item":"blueprint"}}', 'Ünïcødé ✓ 工厂 🚂', 'a\nb\r\n', 'x'.repeat(100_000)];

describe('sha256Hex', () => {
	test('known vectors', async () => {
		expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
		expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	});

	test('text: the same as the old helpers and Node', async () => {
		for (const t of TEXTS) {
			const hex = await sha256Hex(t);
			expect(/^[0-9a-f]{64}$/.test(hex)).toBe(true);
			expect(hex).toBe(await oldText(t));
			expect(hex).toBe(await oldUploads(t));
			expect(hex.slice(0, 12)).toBe(await oldShort(t));
			expect(hex).toBe(createHash('sha256').update(t, 'utf8').digest('hex'));
		}
	});

	test('bytes: Uint8Array (also a view into a larger buffer) and ArrayBuffer', async () => {
		const bytes = new Uint8Array(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256));
		const view = new Uint8Array(new Uint8Array([9, 9, ...bytes, 9]).buffer, 2, bytes.length);
		const want = createHash('sha256').update(bytes).digest('hex');
		expect(await sha256Hex(bytes)).toBe(want);
		expect(await sha256Hex(bytes)).toBe(await oldUploads(bytes));
		expect(await sha256Hex(view)).toBe(want);
		expect(await sha256Hex(view)).toBe(await oldUploads(view));
		expect(await sha256Hex(bytes.buffer)).toBe(want);
		// Text and its UTF-8 bytes hash alike.
		for (const t of TEXTS) expect(await sha256Hex(new TextEncoder().encode(t))).toBe(await sha256Hex(t));
	});
});
