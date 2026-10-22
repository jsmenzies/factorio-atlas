import { afterEach, describe, expect, mock, test } from 'bun:test';

/** A RENDERS bucket stand-in: `get` returns the object for a key, or throws. */
let get: (key: string) => Promise<{ body: ReadableStream; httpEtag: string } | null> = async () => null;
mock.module('cloudflare:workers', () => ({ env: { RENDERS: { get: (key: string) => get(key) } } }));
mock.module('$app/env', () => ({ dev: false }));
const { renderedPages, getRenderSidecar } = await import('#lib/server/renders.js');

const object = (text: string) => ({ body: new Blob([text]).stream(), httpEtag: '"x"' });
const warn = console.warn;
afterEach(() => {
	console.warn = warn;
});

describe('renderedPages', () => {
	test('lists the pages of a v2 index', async () => {
		get = async (key) => (key === 'p/index.json' ? object(JSON.stringify({ v: 2, pages: { '': {}, '3/1': {} } })) : null);
		expect(await renderedPages('p')).toEqual(['', '3/1']);
	});

	test('is empty when the print has no index', async () => {
		get = async () => null;
		expect(await renderedPages('p')).toEqual([]);
	});

	test('is empty, with a warning, when the bucket read fails or the index is not JSON', async () => {
		const warnings: unknown[] = [];
		console.warn = (...args: unknown[]) => warnings.push(args);
		get = async () => {
			throw new Error('R2 unavailable');
		};
		expect(await renderedPages('p')).toEqual([]);
		expect(await getRenderSidecar('p', '0')).toBeNull();
		get = async () => object('{not json');
		expect(await renderedPages('p')).toEqual([]);
		expect(warnings.length).toBe(3);
	});
});
