import { describe, expect, test } from 'bun:test';
import { scopeArgs, startArgs } from './dev-plugin.js';

describe('render start requests', () => {
	test('only validated numbers and fixed words reach the command line', () => {
		expect(startArgs({ next: 100, upload: 'prod', workers: 6 }, '/m')).toEqual([
			'--from-clone',
			'/m',
			'--next',
			'100',
			'--upload',
			'prod',
			'--workers',
			'6'
		]);
		expect(startArgs({ next: 3 }, '/m')).toEqual(['--from-clone', '/m', '--next', '3']);
		expect(startArgs({ resume: true }, '/m')).toEqual(['--resume']);
		expect(startArgs({ next: 1000, top: 1000, refreshTop: true, upload: 'local' }, '/m')).toEqual([
			'--from-clone',
			'/m',
			'--next',
			'1000',
			'--top',
			'1000',
			'--refresh-top',
			'--upload',
			'local'
		]);
		for (const bad of [
			{ next: '5; rm -rf /' },
			{ next: 0 },
			{ next: 1.5 },
			{ next: 5, upload: 'dev' },
			{ next: 5, workers: 100 },
			{ next: 5, force: 'yes' },
			{ next: 5, extra: 1 },
			{ resume: true, next: 5 },
			{ next: 5, top: 0 },
			{ next: 5, top: '10' },
			{ next: 5, refreshTop: true },
			{ next: 5, top: 10, refreshTop: 'yes' },
			[],
			null
		])
			expect(typeof startArgs(bad, '/m')).toBe('string');
	});
});

describe('top and check requests', () => {
	test('only a validated N reaches the command line', () => {
		expect(scopeArgs('top', { n: 1000 }, '/m')).toEqual(['top', '1000', '--from-clone', '/m', '--json']);
		expect(scopeArgs('check', {}, '/m')).toEqual(['check', '--from-clone', '/m', '--json']);
		for (const bad of [{ n: 0 }, { n: '5' }, { n: 2.5 }, { n: 5, x: 1 }, [], null])
			expect(typeof scopeArgs('top', bad, '/m')).toBe('string');
		expect(typeof scopeArgs('check', { n: 5 }, '/m')).toBe('string');
	});
});
