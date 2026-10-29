/** Reading a step command's output: its summary line and its `--json` result. */

const lines = (text: string) =>
	text
		.split(/[\r\n]+/)
		.map((l) => l.trim())
		.filter(Boolean);

/** The last line that reads as a result (✓/✗ first, its mark dropped), else the last line. */
export const lastLine = (text: string) => {
	const all = lines(text);
	return (all.findLast((l) => /^[✓✗]/.test(l)) ?? all.at(-1) ?? '').replace(/^[✓✗]\s*/, '').slice(0, 300);
};

/** The last line that matches `re`, else lastLine's pick. */
export const lineMatching = (text: string, re: RegExp) => (lines(text).findLast((l) => re.test(l)) ?? lastLine(text)).slice(0, 300);

/**
 * A `--json` command's result: the last line that parses as a JSON object (stderr lines, such as a
 * busy database's stack trace, may come after it), or null.
 */
export const lastJsonLine = <T = unknown>(text: string): T | null => {
	for (const line of lines(text).reverse()) {
		if (!line.startsWith('{')) continue;
		try {
			return JSON.parse(line) as T;
		} catch {
			// Not JSON after all: keep looking.
		}
	}
	return null;
};
