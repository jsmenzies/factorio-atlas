import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { collect, imageOf } from './records.js';
import { canaryDue, parseArgs, screenshotsDir, UsageError } from './args.js';

const defaults = { clone: '~/mirror', disk: '/repo/data/raw/factorioprints', root: '/repo' };

test('parseArgs defaults and flags', () => {
	expect(parseArgs([], defaults)).toEqual({
		mode: 'fetch',
		target: null,
		jobs: 6,
		clone: join(homedir(), 'mirror'),
		disk: null,
		ids: null,
		limit: null,
		rate: 4,
		inFlight: 4,
		recheckDead: false,
		planOnly: false,
		canary: true,
		json: false
	});
	const a = parseArgs(
		[
			'--from-clone',
			'c',
			'--from-disk',
			'--ids',
			'-KnQ865j-qQ21WoUPbd3,8B9jpx6',
			'--limit',
			'200',
			'--rate',
			'10',
			'--in-flight',
			'14',
			'--recheck-dead',
			'--plan-only',
			'--no-canary',
			'--json'
		],
		defaults
	);
	expect(a).toEqual({
		mode: 'fetch',
		target: null,
		jobs: 6,
		clone: '/repo/c',
		disk: '/repo/data/raw/factorioprints',
		ids: ['-KnQ865j-qQ21WoUPbd3', '8B9jpx6'],
		limit: 200,
		rate: 10,
		inFlight: 14,
		recheckDead: true,
		planOnly: true,
		canary: false,
		json: true
	});
	expect(parseArgs(['--from-disk', 'raw'], defaults).disk).toBe('/repo/raw');
});

test('parseArgs: the steps after the fetch', () => {
	expect(parseArgs(['--make', '--jobs', '8'], defaults)).toMatchObject({ mode: 'make', jobs: 8 });
	expect(parseArgs(['--upload', 'prod', '--limit', '5'], defaults)).toMatchObject({ mode: 'upload', target: 'prod', limit: 5 });
	expect(parseArgs(['--make', '--ids', '8B9jpx6'], defaults)).toMatchObject({ mode: 'make', ids: ['8B9jpx6'] });
	expect(() => parseArgs(['--upload', 'staging'], defaults)).toThrow(UsageError);
	expect(() => parseArgs(['--make', '--upload', 'prod'], defaults)).toThrow(UsageError);
	expect(() => parseArgs(['--recheck'], defaults)).toThrow('unknown option --recheck');
	expect(() => parseArgs(['--jobs', '0'], defaults)).toThrow(UsageError);
});

test('parseArgs refuses bad input', () => {
	expect(() => parseArgs(['--limit', '0'], defaults)).toThrow(UsageError);
	expect(() => parseArgs(['--limit'], defaults)).toThrow(UsageError);
	expect(() => parseArgs(['--ids', 'not/an/id'], defaults)).toThrow(UsageError);
	for (const bad of ['0', '-1', '21', 'fast']) expect(() => parseArgs(['--rate', bad], defaults)).toThrow(UsageError);
	for (const bad of ['0', '1.5', '33', 'many']) expect(() => parseArgs(['--in-flight', bad], defaults)).toThrow(UsageError);
	expect(parseArgs(['--rate', '2.5'], defaults).rate).toBe(2.5);
	expect(() => parseArgs(['--wat'], defaults)).toThrow(UsageError);
});

test('canaryDue: every 500th stored image, never before the first', () => {
	expect([0, 1, 499, 500, 501, 1000].map((n) => canaryDue(n))).toEqual([false, false, false, true, false, true]);
	expect(canaryDue(3, 3)).toBe(true);
});

test('screenshotsDir', () => {
	expect(screenshotsDir('/repo', '')).toBe('/repo/data/screenshots');
	expect(screenshotsDir('/repo', ' ~/shots ')).toBe(join(homedir(), 'shots'));
	expect(screenshotsDir('/repo', 'rel')).toBe('/repo/rel');
});

test('imageOf and collect: one entry per Imgur id, with every print that uses it', () => {
	expect(imageOf({ image: { id: '8B9jpx6', type: 'image/jpeg', width: 1 } })).toEqual({ id: '8B9jpx6', type: 'image/jpeg' });
	expect(imageOf({ image: { id: '../etc' } })).toBeNull();
	expect(imageOf({})).toBeNull();
	expect(imageOf(null)).toBeNull();
	const { wanted, noImage } = collect([
		{ print: 'p1', image: { id: 'aaaaaaa', type: null } },
		{ print: 'p2', image: { id: 'bbbbbbb', type: 'image/png' } },
		{ print: 'p3', image: { id: 'aaaaaaa', type: 'image/png' } },
		{ print: 'p4', image: null }
	]);
	expect(wanted).toEqual([
		{ id: 'aaaaaaa', prints: ['p1', 'p3'], labelled: 'image/png' },
		{ id: 'bbbbbbb', prints: ['p2'], labelled: 'image/png' }
	]);
	expect(noImage).toEqual(['p4']);
});
