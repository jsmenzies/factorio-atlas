import { describe, expect, test } from 'bun:test';
import { withSignInMark } from './last-sign-in.js';

describe('withSignInMark', () => {
	test('marks the path with the provider in its fragment', () => {
		expect(withSignInMark('/', 'github')).toBe('/#signed-in=github');
		expect(withSignInMark('/prints/x?page=2', 'discord')).toBe('/prints/x?page=2#signed-in=discord');
	});

	test('leaves a path with its own fragment as it is', () => {
		expect(withSignInMark('/account#uploads', 'google')).toBe('/account#uploads');
	});
});
