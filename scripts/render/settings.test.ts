import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRendersDir } from './settings.js';

test('checkRendersDir refuses a folder without the done renders', () => {
	const dir = mkdtempSync(join(tmpdir(), 'renders-'));
	// Nothing done yet: any folder will do.
	expect(checkRendersDir(dir, [], 0)).toBeNull();
	// Done pages, none of them here: the wrong folder.
	expect(checkRendersDir(dir, ['a', 'b'], 12)).toContain('none of the renders');
	// One of the sample is here: the right folder (a print may have been removed since).
	mkdirSync(join(dir, 'b'));
	writeFileSync(join(dir, 'b', 'index.json'), '{}');
	expect(checkRendersDir(dir, ['a', 'b'], 12)).toBeNull();
});
