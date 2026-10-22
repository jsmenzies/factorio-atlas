import { describe, expect, test } from 'bun:test';
import { deleteGraceMs, openStore } from './target.js';
import { DELETE_GRACE_MS } from './upload.js';

describe('openStore', () => {
	const bucket = {} as R2Bucket;

	test('no target, no store; local is the miniflare binding', async () => {
		expect(await openStore(null, bucket, {})).toBeNull();
		expect((await openStore('local', bucket, {}))?.label).toBe('local RENDERS bucket (.wrangler/state)');
	});

	test('prod needs an R2 API token', async () => {
		await expect(openStore('prod', bucket, {})).rejects.toThrow('--upload prod needs an R2 API token');
		await expect(openStore('prod', bucket, { R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: ' ' })).rejects.toThrow('needs an R2 API token');
	});
});

describe('deleteGraceMs', () => {
	test('the default unless RENDER_DELETE_GRACE_S is set', () => {
		expect(deleteGraceMs(undefined, 'prod')).toBe(DELETE_GRACE_MS);
		expect(deleteGraceMs('  ', 'local')).toBe(DELETE_GRACE_MS);
		expect(deleteGraceMs('600', 'prod')).toBe(600_000);
	});

	test('below the caches only for the local bucket', () => {
		expect(deleteGraceMs('0', 'local')).toBe(0);
		expect(() => deleteGraceMs('10', 'prod')).toThrow('only --upload local takes less');
		expect(() => deleteGraceMs('soon', 'local')).toThrow('must be a number of seconds, not soon');
		expect(() => deleteGraceMs('-1', 'local')).toThrow('must be a number of seconds');
	});
});
