import { describe, expect, test } from 'bun:test';
import { SECURITY_HEADERS, withSecurityHeaders } from './security-headers.js';

describe('withSecurityHeaders', () => {
	test('sets every header and keeps the rest of the response', async () => {
		const res = withSecurityHeaders(new Response('hi', { status: 201, headers: { 'cache-control': 'public, max-age=60' } }));
		for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(k)).toBe(v);
		expect([res.status, res.headers.get('cache-control'), await res.text()]).toEqual([201, 'public, max-age=60', 'hi']);
	});
	test('copies a response whose headers are immutable', () => {
		const res = withSecurityHeaders(Response.redirect('https://example.com/', 301));
		expect([res.status, res.headers.get('location'), res.headers.get('x-content-type-options')]).toEqual([
			301,
			'https://example.com/',
			'nosniff'
		]);
	});
});
