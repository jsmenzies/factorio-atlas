import { Effect } from 'effect';
import { BlueprintDecodeError } from './errors.js';

/**
 * Zip-bomb guard. The largest real print inflates to about 120 MB, close to this default;
 * offline runs (backfill, sync) pass `OFFLINE_MAX_INFLATED_BYTES` instead. A Worker isolate
 * has 128 MB in total, so the default only matters for small prints there anyway.
 */
export const MAX_INFLATED_BYTES = 128 * 1024 * 1024;
export const OFFLINE_MAX_INFLATED_BYTES = 192 * 1024 * 1024;

const inflate = async (bytes: Uint8Array, maxBytes: number): Promise<string> => {
	// Factorio uses zlib framing, which is what DecompressionStream calls "deflate".
	const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error(`inflated size exceeds ${maxBytes} bytes`);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return new TextDecoder().decode(out);
};

const base64ToBytes = (b64: string): Uint8Array => {
	const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
	const bin = atob(padded);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
};

/**
 * Decode a Factorio exchange string: version byte "0" + base64(zlib(JSON)).
 * Raw JSON (which 2.0 can also import) is accepted as-is.
 */
export const decodeExchangeString = (input: string, { maxInflatedBytes = MAX_INFLATED_BYTES }: { maxInflatedBytes?: number } = {}) =>
	Effect.gen(function* () {
		const s = input.trim();
		if (!s) return yield* new BlueprintDecodeError({ reason: 'empty string' });
		if (s.startsWith('{')) {
			return yield* Effect.try({
				try: () => JSON.parse(s) as unknown,
				catch: (cause) => new BlueprintDecodeError({ reason: 'json', cause })
			});
		}
		const compact = s.replace(/\s+/g, '');
		if (compact[0] !== '0') {
			return yield* new BlueprintDecodeError({ reason: `unsupported version byte ${JSON.stringify(compact[0])}` });
		}
		const bytes = yield* Effect.try({
			try: () => base64ToBytes(compact.slice(1)),
			catch: (cause) => new BlueprintDecodeError({ reason: 'base64', cause })
		});
		const text = yield* Effect.tryPromise({
			try: () => inflate(bytes, maxInflatedBytes),
			catch: (cause) => new BlueprintDecodeError({ reason: 'zlib', cause })
		});
		return yield* Effect.try({
			try: () => JSON.parse(text) as unknown,
			catch: (cause) => new BlueprintDecodeError({ reason: 'json', cause })
		});
	});

/** Packed 64-bit version: major<<48 | minor<<32 | patch<<16 | build. */
export const decodeGameVersion = (v: unknown): [number, number, number, number] | null => {
	if (typeof v !== 'number' || !Number.isFinite(v)) return null;
	// Beyond 2^53 a JS number loses the low bits, so go through BigInt.
	const n = BigInt(Math.round(v));
	const part = (shift: bigint) => Number((n >> shift) & 0xffffn);
	return [part(48n), part(32n), part(16n), part(0n)];
};

/**
 * A book entry's slot, the step in every book path: its `index`, else its position in the book's
 * `blueprints` array, as the game places entries without one on import (codex books leave it out).
 */
export const bookEntryIndex = (entry: unknown, position: number): number => {
	const index = entry && typeof entry === 'object' ? (entry as { index?: unknown }).index : undefined;
	return typeof index === 'number' ? index : position;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
	let bin = '';
	// Chunked: String.fromCharCode(...bytes) overflows the stack on large prints.
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin);
};

/** The reverse of decodeExchangeString: "0" + base64(zlib(JSON)), importable in game. */
export const encodeExchangeString = async (value: unknown): Promise<string> => {
	const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('deflate'));
	return '0' + bytesToBase64(new Uint8Array(await new Response(stream).arrayBuffer()));
};
