import { describe, expect, test } from 'bun:test';
import { adminDenial, isAdminPath, withAdminHeaders } from './guard.js';

describe('isAdminPath', () => {
	for (const path of [
		'/admin',
		'/admin/',
		'/admin/pipeline',
		'/admin/pipeline/__data.json',
		'/ADMIN/pipeline',
		'/%61dmin/pipeline',
		'//admin/x',
		'/%E0%A4%A'
	]) {
		test(`${path} is admin`, () => expect(isAdminPath(path)).toBe(true));
	}
	for (const path of ['/', '/administrator', '/prints/admin', '/adminx']) {
		test(`${path} is not`, () => expect(isAdminPath(path)).toBe(false));
	}
	test('route id counts too', () => expect(isAdminPath('/elsewhere', '/admin/pipeline/[runId]')).toBe(true));
});

describe('adminDenial', () => {
	const request = new Request('https://example.com/admin/pipeline');
	test('dev is allowed', async () => expect(await adminDenial(request, {}, true)).toBe(null));
	test('deployed without config fails closed', async () => {
		expect(await adminDenial(request, {}, false)).toBe('ACCESS_TEAM_DOMAIN or ACCESS_AUD is not set');
		expect(await adminDenial(request, { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: '' }, false)).toBe(
			'ACCESS_TEAM_DOMAIN or ACCESS_AUD is not set'
		);
	});
	test('deployed without a token is denied', async () => {
		expect(await adminDenial(request, { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud' }, false)).toBe(
			'no Access token'
		);
	});
});

test('admin responses are never cached or indexed, even with immutable headers', () => {
	const redirect = withAdminHeaders(Response.redirect('https://example.com/admin/pipeline', 307));
	expect(redirect.headers.get('cache-control')).toBe('no-store, private');
	expect(redirect.headers.get('x-robots-tag')).toBe('noindex, nofollow');
	expect(redirect.status).toBe(307);
});
