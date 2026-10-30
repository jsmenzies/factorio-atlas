import { describe, expect, test } from 'bun:test';
import { SITES } from './print-id';
import { docSources, ownSource, siteUrl, SOURCE_SITES, sourcesOfPrint, sourceUrl, urlText } from './sources';

const FP = '-KYpTULTDIvDOsJfgjeS';

describe('sources', () => {
	test('every site has a name, and a page except uploads', () => {
		for (const site of SITES) {
			expect(SOURCE_SITES[site].name.length).toBeGreaterThan(0);
			expect(SOURCE_SITES[site].url === null).toBe(site === 'upload');
		}
	});

	test('the page of a site id on each site', () => {
		expect(siteUrl('factorioprints', FP)).toBe(`https://factorioprints.com/view/${FP}`);
		expect(siteUrl('factoriobin', 'LYMz5ZJT')).toBe('https://factoriobin.com/post/LYMz5ZJT');
		expect(siteUrl('codex', '492')).toBe('https://factoriocodex.com/blueprints/492');
		expect(siteUrl('fprints', 'ed43db36-b063-41d5-b1ac-99fdd3550ed4')).toBe(
			'https://fprints.xyz/blueprint/ed43db36-b063-41d5-b1ac-99fdd3550ed4'
		);
		expect(siteUrl('upload', 'abcdefghij')).toBeNull();
		expect(urlText(siteUrl('codex', '492')!)).toBe('factoriocodex.com/blueprints/492');
	});

	test('a print id names the source it was first seen on', () => {
		expect(ownSource(FP)).toEqual({ site: 'factorioprints', site_id: FP });
		expect(ownSource('up-abcdefghij')).toEqual({ site: 'upload', site_id: 'abcdefghij' });
		expect(ownSource('fbin-LYMz5ZJT')).toEqual({ site: 'factoriobin', site_id: 'LYMz5ZJT' });
		expect(ownSource('codex-492')).toEqual({ site: 'codex', site_id: '492' });
		expect(ownSource('fprints-ed43db36-b063')).toEqual({ site: 'fprints', site_id: 'ed43db36-b063' });
		expect(ownSource('not an id')).toBeNull();
		expect(sourceUrl(FP)).toBe(`https://factorioprints.com/view/${FP}`);
		expect(sourceUrl('codex-492')).toBe('https://factoriocodex.com/blueprints/492');
		expect(sourceUrl('up-abcdefghij')).toBeNull();
	});

	test('a document lists its sources only when they are not just its own', () => {
		const own = { site: 'factorioprints', site_id: FP } as const;
		const bin = { site: 'factoriobin', site_id: 'LYMz5ZJT' } as const;
		expect(docSources(FP, [own])).toBeUndefined();
		expect(docSources(FP, [])).toBeUndefined();
		expect(docSources(FP, [own, bin])).toEqual([own, bin]);
		// The credited source went: another site's alone.
		expect(docSources(FP, [bin])).toEqual([bin]);
		expect(sourcesOfPrint({ id: FP })).toEqual([own]);
		expect(sourcesOfPrint({ id: FP, sources: [bin, own] })).toEqual([bin, own]);
		expect(sourcesOfPrint({ id: 'nonsense' })).toEqual([]);
	});
});
