import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { rendersDir, thumbsDir } from './renders-dir.js';

test('RENDERS_DIR, with ~ expanded and relative paths from the root; else data/renders', () => {
	expect(rendersDir('/repo', '')).toBe('/repo/data/renders');
	expect(rendersDir('/repo', '  ')).toBe('/repo/data/renders');
	expect(rendersDir('/repo', '/srv/renders')).toBe('/srv/renders');
	expect(rendersDir('/repo', '~/data/renders')).toBe(join(homedir(), 'data/renders'));
	expect(rendersDir('/repo', '../renders')).toBe('/renders');
});

test('THUMBS_DIR, else data/thumbs', () => {
	expect(thumbsDir('/repo', '')).toBe('/repo/data/thumbs');
	expect(thumbsDir('/repo', '~/data/thumbs')).toBe(join(homedir(), 'data/thumbs'));
});
