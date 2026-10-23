import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { rendersDir } from './renders-dir.js';

test('RENDERS_DIR, with ~ expanded and relative paths from the root; else data/renders', () => {
	expect(rendersDir('/repo', '')).toBe('/repo/data/renders');
	expect(rendersDir('/repo', '  ')).toBe('/repo/data/renders');
	expect(rendersDir('/repo', '/srv/renders')).toBe('/srv/renders');
	expect(rendersDir('/repo', '~/data/renders')).toBe(join(homedir(), 'data/renders'));
	expect(rendersDir('/repo', '../renders')).toBe('/renders');
});
