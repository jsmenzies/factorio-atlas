import { describe, expect, test } from 'bun:test';
import { isFactorioprintsId, isPrintId, printIdFor, showsFavourites, siteOfPrintId } from './print-id';

describe('print ids', () => {
	test('accepts every site’s ids and nothing else', () => {
		for (const id of [
			'-LI0gc-a-2_VLWR-tx1d',
			'up-7fK2pQ9xLm',
			'fbin-LYMz5ZJT',
			'codex-492',
			'fprints-0f8e7c1a-1b2c-4d5e-8f90-a1b2c3d4e5f6'
		]) {
			expect(isPrintId(id)).toBe(true);
		}
		for (const id of ['', 'abc', '-LI0gc-a-2_VLWR-tx1', 'up-7fK2pQ9xL', 'up-7fK2pQ9x_m', 'xyz-123', 'fbin-', 'fbin-a/b', '../etc/passwd']) {
			expect(isPrintId(id)).toBe(false);
		}
		expect(isFactorioprintsId('up-7fK2pQ9xLm')).toBe(false);
	});

	test('printIdFor and siteOfPrintId agree', () => {
		expect(printIdFor('upload', '7fK2pQ9xLm')).toBe('up-7fK2pQ9xLm');
		expect(printIdFor('factoriobin', 'LYMz5ZJT')).toBe('fbin-LYMz5ZJT');
		expect(printIdFor('factorioprints', '-LI0gc-a-2_VLWR-tx1d')).toBe('-LI0gc-a-2_VLWR-tx1d');
		expect(siteOfPrintId('up-7fK2pQ9xLm')).toBe('upload');
		expect(siteOfPrintId('codex-492')).toBe('codex');
		expect(siteOfPrintId('-LI0gc-a-2_VLWR-tx1d')).toBe('factorioprints');
		expect(siteOfPrintId('nope')).toBeNull();
		// A site id that would land in factorioprints' 20-character space is refused.
		expect(() => printIdFor('factoriobin', 'abcdefghijklmno')).toThrow();
		expect(() => printIdFor('upload', 'short')).toThrow();
	});
});

describe('showsFavourites', () => {
	test('only a factorioprints record has a count; documents without a source go by the id', () => {
		expect(showsFavourites('factorioprints', 'up-AbCdEfGhIj')).toBe(true);
		expect(showsFavourites('upload', '-KYpTULTDIvDOsJfgjeS')).toBe(false);
		expect(showsFavourites(undefined, 'up-AbCdEfGhIj')).toBe(false);
		expect(showsFavourites(undefined, '-KYpTULTDIvDOsJfgjeS')).toBe(true);
	});
});
