import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRendersDir, drawnKey, inputKey } from './settings.js';

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

test('drawnKey measures a drawn page against the assets that drew it', () => {
	const page = '{"entities":[]}';
	const old = { id: '2.0.77/d534ffb54322', fpsr: '0.0.3' };
	const now = { id: '2.1.23/3180e0bbd3b4', fpsr: '0.0.3' };
	const drawn = inputKey(page, old);
	// New assets: the page drawn with the old ones still matches; new work gets a new key.
	expect(drawnKey(page, old.id, now)).toBe(drawn);
	expect(inputKey(page, now)).not.toBe(drawn);
	// A changed page, or a new fpsr, still means a redraw.
	expect(drawnKey('{"entities":[{}]}', old.id, now)).not.toBe(drawn);
	expect(drawnKey(page, old.id, { ...now, fpsr: '0.0.4' })).not.toBe(drawn);
});
