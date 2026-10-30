import { expect, test } from 'bun:test';
import { listedVersions, versionTokens } from './repository';

test('listedVersions: what labels claim; an upload that claims nothing lists the version it was saved in', () => {
	const upload = { source: { site: 'upload' as const, siteId: 'AbCdEfGhIj', url: '' } };
	expect(listedVersions(upload, { claimedVersions: [], gameVersion: '2.0.72' })).toEqual(['2.0']);
	expect(listedVersions(upload, { claimedVersions: ['1.1'], gameVersion: '2.0.72' })).toEqual(['1.1']);
	expect(listedVersions(upload, { claimedVersions: [], gameVersion: null })).toEqual([]);
	// factorioprints rows stay as they were.
	expect(listedVersions({}, { claimedVersions: [], gameVersion: '2.0.72' })).toEqual([]);
	// The listed "2.0" is a version filter its `v_` tokens already match.
	expect(versionTokens('2.0.72')).toContain(versionTokens('2.0').at(-1)!);
});
