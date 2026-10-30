import { describe, expect, test } from 'bun:test';
import { failureLine, lastJsonLine, lastLine, lineMatching } from './output';

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

	test("a failure's summary is its error line, not the counts printed on the way out", () => {
		const text = 'run x\nerror: D1_ERROR: no such table: print_sources: SQLITE_ERROR\n✓ 0 analysed  ✗ 0 failed  ↷ 0 skipped\n';
		expect(failureLine(text)).toBe('D1_ERROR: no such table: print_sources: SQLITE_ERROR');
		expect(failureLine('TypeError: x is undefined\n    at foo\n')).toBe('TypeError: x is undefined');
		expect(failureLine('✗ refused: a render run is live\n')).toBe('refused: a render run is live');
	});
});
