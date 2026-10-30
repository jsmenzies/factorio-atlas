import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureRecord } from '#lib/server/fixtures.js';
import type { SourceRecord } from '#lib/server/pipeline/source-record.js';
import { putRecord, recordFile } from '../records/store.js';
import { scanStorePrints } from './store-scope.js';

/** Real strings from the mirror: a 2.0 print (Space Casino, 2.0.72) and a 0.15-era one (All the Belts). */
const MODERN = (JSON.parse(await fixtureRecord('-OlVj1waoXiKkzrQnFss')) as { blueprintString: string }).blueprintString;
const OLD = (JSON.parse(await fixtureRecord('-KYpTULTDIvDOsJfgjeS')) as { blueprintString: string }).blueprintString;

const record = (site: 'codex' | 'fprints' | 'upload', siteId: string, blueprintString: string): SourceRecord => ({
	site,
	siteId,
	url: `https://example.com/${siteId}`,
	title: siteId,
	description: null,
	author: null,
	blueprintString,
	image: null,
	uploadedAt: 1,
	updatedAt: 1,
	favorites: null,
	sourceHints: []
});

describe('scanStorePrints', () => {
	test('store prints with a 2.0+ page and their stamps; a record is decoded again only when it changes', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'store-scope-'));
		try {
			const cache = join(dir, '.cache', 'store-scope.json');
			await putRecord(dir, record('codex', '1', MODERN));
			await putRecord(dir, record('fprints', 'abc', OLD));
			await putRecord(dir, record('upload', 'abcdefghij', 'not a blueprint'));
			const first = await scanStorePrints(dir, cache, 5);
			expect(first.modern.map(([id]) => id)).toEqual(['codex-1']);
			expect(/^\d+:\d+$/.test(first.modern[0][1])).toBe(true);
			expect([first.older, first.unreadable, first.decoded, first.at]).toEqual([1, 1, 3, 5]);

			// Nothing changed: nothing decoded.
			expect((await scanStorePrints(dir, cache)).decoded).toBe(0);
			// An edit moves the stamp: that record alone is decoded again, and its new stamp saved.
			await putRecord(dir, record('fprints', 'abc', MODERN));
			utimesSync(recordFile(dir, 'fprints', 'abc'), 1_800_000_000, 1_800_000_000);
			const again = await scanStorePrints(dir, cache);
			expect(again.decoded).toBe(1);
			expect(again.modern.map(([id]) => id)).toEqual(['codex-1', 'fprints-abc']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
