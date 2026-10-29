import { describe, expect, test } from 'bun:test';
import { lastJsonLine, lastLine, lineMatching } from './output';

describe('step output', () => {
	test('the JSON result is the last line that parses, whatever stderr wrote after it', () => {
		const text = 'working…\n{"n":1000,"cutoff":26}\nError: SQLITE_BUSY\n    at foo (bar.ts:1)\n{not json\n';
		expect(lastJsonLine(text)).toEqual({ n: 1000, cutoff: 26 });
		expect(lastJsonLine('no result')).toBeNull();
	});

	test('the summary is the last ✓/✗ line, else the last line', () => {
		expect(lastLine('a\n✓ 12 written\nnote\n')).toBe('12 written');
		expect(lastLine('a\nb\n')).toBe('b');
		expect(lineMatching('x: done in 2s: 5\ny: 6\n', /^x: done in/)).toBe('x: done in 2s: 5');
		expect(lineMatching('nothing\n', /^x:/)).toBe('nothing');
	});
});
