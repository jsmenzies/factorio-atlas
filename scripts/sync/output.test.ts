import { describe, expect, test } from 'bun:test';
import { failureLine, lastJsonLine, lastLine } from './output';

describe('step output', () => {
	test('the JSON result is the last line that parses, whatever stderr wrote after it', () => {
		const text = 'working…\n{"n":1000,"cutoff":26}\nError: SQLITE_BUSY\n    at foo (bar.ts:1)\n{not json\n';
		expect(lastJsonLine(text)).toEqual({ n: 1000, cutoff: 26 });
		expect(lastJsonLine('no result')).toBeNull();
	});

	test('the summary is the last ✓/✗ line, else the last line', () => {
		expect(lastLine('a\n✓ 12 written\nnote\n')).toBe('12 written');
		expect(lastLine('a\nb\n')).toBe('b');
	});

	test("a failure's summary is its error line, not the counts printed on the way out", () => {
		const text = 'run x\nerror: D1_ERROR: no such table: print_sources: SQLITE_ERROR\n✓ 0 analysed  ✗ 0 failed  ↷ 0 skipped\n';
		expect(failureLine(text)).toBe('D1_ERROR: no such table: print_sources: SQLITE_ERROR');
		expect(failureLine('TypeError: x is undefined\n    at foo\n')).toBe('TypeError: x is undefined');
		expect(failureLine('✗ refused: a render run is live\n')).toBe('refused: a render run is live');
	});
});

/**
 * The screenshots step once read its summaries back out of these log lines (the lines are unchanged); now each
 * command's `--json` result carries the line's text as `summary`. The old reading, kept here as the proof that the
 * typed summary is what the line gave, on the lines of real updates.
 */
describe('the screenshots step: typed summaries are what its log lines gave', () => {
	const lastMatching = (text: string, re: RegExp) =>
		(
			text
				.split('\n')
				.map((l) => l.trim())
				.findLast((l) => re.test(l)) ?? lastLine(text)
		).slice(0, 300);
	const fetchSummary = (tail: string) =>
		lastMatching(tail, /^screenshots: (done in |\d+ already copied)/)
			.replace(/^screenshots: /, '')
			.replace(/ → .*$/, '');
	const uploadSummary = (tail: string) =>
		lastMatching(tail, /^screenshots: \S+ bucket: /)
			.replace(/^screenshots: /, '')
			.replace(/\. Then: .*$/, '');
	const flagsWritten = (tail: string) => Number(/([\d,]+) D1 rows written/.exec(tail)?.[1]?.replace(/,/g, '') ?? 0);

	test('the fetch: its plan line (nothing to fetch, or stopped) and its run line', () => {
		const planned = '18111 already copied, 2 dead; to fetch 0 (0 failed before, 0 files missing, 0 dead rechecked)';
		const ran =
			'done in 26s: fetched 89 (109.0 MB), dead 0, failed 0, served as another type than the record says 3 (png→jpeg 3); 0 of this run’s 89 not done';
		const records = 'screenshots: 18226 records in /x; 18113 images (113 prints without one)';
		expect(fetchSummary(`${records}\nscreenshots: ${planned} → /x\n`)).toBe(planned);
		expect(fetchSummary(`${records}\nscreenshots: ${planned} → /x\nscreenshots: 12/89 · 4.0/s\nscreenshots: ${ran}\n`)).toBe(ran);
	});

	test('the upload and the search cards’ flags', () => {
		const summary = 'prod bucket: 18840 images in 365s: made 686, put 4653 files (1348.0 MB), deleted 0, already up 18154, failed 0';
		expect(
			uploadSummary(`screenshots: 18840 images to bring in line in the prod bucket (18154 uploaded there before)
screenshots: 100/18840 · made 3 · put 21 files (2.0 MB) · deleted 0 · 15s
screenshots: ${summary}. Then: bun run screenshots:flags --stage prod
`)
		).toBe(summary);
		for (const [line, written] of [
			['✓ 686 D1 rows written; cached pages purged', 686],
			['✓ 18,111 D1 rows written; cached pages purged', 18_111],
			['already in sync; nothing written', 0]
		] as const) {
			const tail = `the prod bucket's manifests: 18,111 copied, 2 dead, 0 removed\nprod-db: 0 rows to set\n${line}\n`;
			expect(lastLine(tail)).toBe(line.replace(/^✓ /, ''));
			expect(flagsWritten(tail)).toBe(written);
		}
	});
});
